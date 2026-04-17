import { FastifyReply, FastifyRequest } from "fastify";
import { PrismaClient } from "@prisma/client";
import { embeddings } from "../../../utils/embeddings";
import { DialoqbaseVectorStore } from "../../../utils/store";
import { chatModelProvider } from "../../../utils/models";
import { BaseRetriever } from "@langchain/core/retrievers";
import { DialoqbaseHybridRetrival } from "../../../utils/hybrid";
import { createChain } from "../../../chain/index";
import { getModelInfo } from "../../../utils/get-model-info";

const prisma = new PrismaClient();

// In-memory cache to prevent duplicate webhook processing (5 seconds TTL)
const processedMessagesCache = new Set<string>();

export const chatRequestHandler = async (
  request: FastifyRequest<{
    Params: {
      id?: string;
    };
    Body: any;
  }>,
  reply: FastifyReply
) => {
  const botId = request.params.id;
  const body = request.body;
  const anyBody = body as any;

  console.log("--- INCOMING APIWASS WEBHOOK ---");
  console.log(JSON.stringify(anyBody, null, 2));

  let bot;

  if (botId) {
    // Verify bot exists by ID
    bot = await prisma.bot.findUnique({
      where: {
        publicId: botId,
      },
    });
  } else {
    // Global webhook mode: find bot by sessionId
    const sessionId = anyBody?.sessionId;
    if (!sessionId) {
      console.log("ApiWass Global Webhook: Missing sessionId in payload");
      return reply.status(200).send({ message: "OK" });
    }
    
    const bots = await prisma.bot.findMany();
    bot = bots.find((b) => {
      const opts = b.options as any;
      const dbSessionId = opts?.apiwass?.session_id?.trim();
      return dbSessionId && dbSessionId === sessionId?.trim();
    });

    if (!bot) {
      console.log(`ApiWass Global Webhook: No bot found for sessionId '${sessionId}'`);
    }
  }

  if (!bot) {
    return reply.status(404).send({ message: "Bot not found" });
  }

  const options = (bot.options as any) || {};
  const apiwassCreds = options.apiwass;

  if (!apiwassCreds || !apiwassCreds.api_key || !apiwassCreds.session_id) {
    return reply.status(400).send({ message: "ApiWass integration not configured" });
  }

  if (apiwassCreds.is_paused) {
    return reply.status(200).send({ message: "Integration is paused" });
  }

  // Assuming a typical webhook payload format for WhatsApp APIs
  // e.g. { event: "message", payload: { from: "1234567890@c.us", body: "Hello" } }
  // We'll extract sender and message text.
  
  let sender = "";
  let messageText = "";

  if (anyBody?.event) {
    // If it's an ApiWass event, we ONLY want to process 'messages.received'
    if (anyBody.event !== "messages.received") {
      console.log(`ApiWass Webhook: Ignoring event '${anyBody.event}'`);
      return reply.status(200).send({ message: "OK" });
    }
    
    if (anyBody.from && anyBody.text) {
      sender = anyBody.from;
      messageText = anyBody.text;
    } else {
      console.log("ApiWass Webhook: Missing from/text in messages.received");
      return reply.status(200).send({ message: "OK" });
    }
  } else if (anyBody?.payload?.from && anyBody?.payload?.body) {
    sender = anyBody.payload.from;
    messageText = anyBody.payload.body;
  } else if (anyBody?.chatId && anyBody?.message) {
    sender = anyBody.chatId;
    messageText = anyBody.message;
  } else if (anyBody?.messages && anyBody?.messages[0]) {
     // WhatsApp Cloud API format fallback
     sender = anyBody.messages[0].from;
     messageText = anyBody.messages[0].text?.body;
  } else if (anyBody?.data?.from && anyBody?.data?.body) {
    // Evolution API format
    sender = anyBody.data.from;
    messageText = anyBody.data.body;
  } else if (anyBody?.phone && anyBody?.message) {
    // Wassenger format
    sender = anyBody.phone;
    messageText = anyBody.message;
  } else {
    // If we can't parse the message, just return 200 to acknowledge receipt
    console.log("ApiWass Webhook: Unrecognized payload format", body);
    return reply.status(200).send({ message: "OK" });
  }

  if (!messageText) {
    return reply.status(200).send({ message: "OK" });
  }

  // Add a fast in-memory deduplication check (60-second cache)
  // We ignore the timestamp to ensure retries with different timestamps are caught
  // We also use the message ID from the raw object if available, as it's the most reliable
  const messageHash = anyBody?.raw?.key?.id || anyBody?.id || anyBody?.messages?.[0]?.id || `${sender}-${messageText.trim()}`;
  
  // SYNCHRONOUS CACHE CHECK FIRST (Crucial for Node.js single-thread event loop)
  if (processedMessagesCache.has(messageHash)) {
    console.log(`ApiWass Webhook: Ignoring duplicate message (cache hit for ${messageHash})`);
    return reply.status(200).send({ message: "OK" });
  }

  // ADD TO CACHE IMMEDIATELY BEFORE ANY AWAIT
  // This prevents race conditions if two requests arrive at the exact same millisecond
  processedMessagesCache.add(messageHash);
  setTimeout(() => {
    processedMessagesCache.delete(messageHash);
  }, 60000);

  // Check DB just in case (e.g. multi-instance deployments or server restarts)
  const isAlreadyProcessed = await prisma.botWhatsappHistory.findFirst({
    where: {
      chat_id: messageHash,
    },
  });

  if (isAlreadyProcessed) {
    console.log(`ApiWass Webhook: Ignoring duplicate message (DB hit for ${messageHash})`);
    return reply.status(200).send({ message: "OK" });
  }

  // CREATE A PENDING RECORD IN THE DB IMMEDIATELY TO PREVENT RACE CONDITIONS ACROSS REPLICAS
  await prisma.botWhatsappHistory.create({
    data: {
      identifier: `${bot.id}-${sender}`,
      chat_id: messageHash, 
      from: sender,
      human: messageText,
      bot: "...", // Placeholder, will be updated later
      bot_id: bot.id,
    },
  });

  // Acknowledge webhook immediately to prevent retries from ApiWass
  reply.status(200).send({ message: "OK" });

  // Process message with Dialoqbase bot in the background
  // We use setTimeout to completely detach this from the Fastify request lifecycle
  setTimeout(async () => {
    try {
      console.log(`[ApiWass] Iniciando procesamiento para el mensaje de ${sender}`);
      const chat_history = await prisma.botWhatsappHistory.findMany({
      where: {
        from: sender,
        identifier: `${bot.id}-${sender}`,
      },
      orderBy: {
        createdAt: "asc"
      }
    });

    if (chat_history.length > 20) {
      chat_history.splice(0, chat_history.length - 20);
    }

    let history: any[] = chat_history.map((message) => ({
      human: message.human,
      ai: message.bot,
    }));

    const temperature = bot.temperature;
    const sanitizedQuestion = messageText.trim().replaceAll("\n", " ");
    
    const embeddingInfo = await getModelInfo({
      model: bot.embedding,
      prisma,
      type: "embedding",
    });

    if (!embeddingInfo) {
      return reply.status(500).send({ message: "Embedding not found" });
    }

    const embeddingModel = embeddings(
      embeddingInfo.model_provider!.toLowerCase(),
      embeddingInfo.model_id,
      embeddingInfo?.config
    );

    let retriever: BaseRetriever;

    if (bot.use_hybrid_search) {
      retriever = new DialoqbaseHybridRetrival(embeddingModel, {
        botId: bot.id,
        sourceId: null,
      });
    } else {
      const vectorstore = await DialoqbaseVectorStore.fromExistingIndex(
        embeddingModel,
        {
          botId: bot.id,
          sourceId: null,
        }
      );

      retriever = vectorstore.asRetriever({});
    }

    const modelinfo = await getModelInfo({
      model: bot.model,
      prisma,
      type: "chat",
    });

    if (!modelinfo) {
      return reply.status(500).send({ message: "Model not found" });
    }

    const botConfig: any = (modelinfo.config as {}) || {};
    if (bot.provider.toLowerCase() === "openai") {
      if (bot.bot_model_api_key && bot.bot_model_api_key.trim() !== "") {
        botConfig.configuration = {
          apiKey: bot.bot_model_api_key,
        };
      }
    }

    const model = chatModelProvider(bot.provider, bot.model, temperature, {
      ...botConfig,
    });

    const chain = createChain({
      llm: model,
      question_llm: model,
      question_template: bot.questionGeneratorPrompt,
      response_template: bot.qaPrompt,
      retriever,
    });

    const response = await chain.invoke({
      question: sanitizedQuestion,
      chat_history: history,
    });

    const botReply = response;

    // Update the pending history record with the actual bot reply
    await prisma.botWhatsappHistory.updateMany({
      where: {
        chat_id: messageHash,
        bot_id: bot.id,
      },
      data: {
        bot: botReply,
      },
    });

    // Send reply via ApiWass API
    const apiUrl = `https://apiwass.com/api/sessions/${apiwassCreds.session_id}/messages/text`;
    
    console.log(`[ApiWass] Enviando respuesta a ${sender}: "${botReply.substring(0, 50)}..."`);
    
    const sendResponse = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiwassCreds.api_key
      },
      body: JSON.stringify({
        phone: sender.replace("@c.us", "").replace("@s.whatsapp.net", ""),
        message: botReply,
      }),
    });

    if (!sendResponse.ok) {
       console.error("[ApiWass] Error al enviar mensaje:", await sendResponse.text());
    } else {
       console.log(`[ApiWass] Mensaje enviado correctamente (Status: ${sendResponse.status})`);
    }

    } catch (error) {
      console.error("[ApiWass] Error procesando el mensaje:", error);
    }
  }, 0);

  return reply;
};
