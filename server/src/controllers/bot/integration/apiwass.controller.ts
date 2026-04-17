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

export const chatRequestHandler = async (
  request: FastifyRequest<{
    Params: {
      id: string;
    };
    Body: any;
  }>,
  reply: FastifyReply
) => {
  const botId = request.params.id;
  const body = request.body;

  // Verify bot exists and apiwass integration is configured
  const bot = await prisma.bot.findUnique({
    where: {
      publicId: botId,
    },
  });

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

  const anyBody = body as any;

  if (anyBody?.event === "messages.received" && anyBody?.from && anyBody?.text) {
    // ApiWass official format
    sender = anyBody.from;
    messageText = anyBody.text;
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

  // Process message with Dialoqbase bot
  try {
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

    // Save history
    await prisma.botWhatsappHistory.create({
      data: {
        identifier: `${bot.id}-${sender}`,
        chat_id: `apiwass-${Date.now()}`,
        from: sender,
        human: messageText,
        bot: botReply,
        bot_id: bot.id,
      },
    });

    // Send reply via ApiWass API
    const apiUrl = `https://apiwass.com/api/sessions/${apiwassCreds.session_id}/messages/text`;
    
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
       console.error("ApiWass send error:", await sendResponse.text());
    }

    return reply.status(200).send({ message: "OK" });
  } catch (error) {
    console.error("ApiWass processing error:", error);
    return reply.status(500).send({ message: "Internal Server Error" });
  }
};
