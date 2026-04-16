import { FastifyReply, FastifyRequest } from "fastify";
import { ChatRequestBody } from "./types";
import { embeddings } from "../../../../../utils/embeddings";
import { createChain, groupMessagesByConversation } from "../../../../../chain";
import { getModelInfo } from "../../../../../utils/get-model-info";
import { nextTick } from "../../../../../utils/nextTick";
import { createGoogleCalendarTool, cancelGoogleCalendarTool, rescheduleGoogleCalendarTool } from "../../../../../tools/google-calendar";
import {
  createChatModel,
  createRetriever,
  getBotConfig,
  handleErrorResponse,
  saveChatHistory,
} from "./chat.service";

export const chatRequestHandler = async (
  request: FastifyRequest<ChatRequestBody>,
  reply: FastifyReply
) => {
  const { id: bot_id } = request.params;
  const { message, history_id } = request.body;
  let history = [];

  try {
    const prisma = request.server.prisma;
    const bot = await prisma.bot.findFirst({
      where: { id: bot_id, user_id: request.user.user_id },
    });

    if (!bot) {
      return handleErrorResponse(
        history,
        message,
        "You are in the wrong place, buddy."
      );
    }


    if (history_id) {
      const details = await prisma.botPlayground.findFirst({
        where: {
          id: history_id,
          botId: bot_id,
        },
        include: {
          BotPlaygroundMessage: {
            orderBy: {
              createdAt: "asc",
            },
          },
        },
      });

      const botMessages = details?.BotPlaygroundMessage.map((message) => ({
        type: message.type,
        text: message.message,
      }));

      history = botMessages || [];
    }

    const embeddingInfo = await getModelInfo({
      model: bot.embedding,
      prisma,
      type: "all",
    });

    if (!embeddingInfo) {
      return handleErrorResponse(history, message, "Unable to find Embedding");
    }

    const embeddingModel = embeddings(
      embeddingInfo.model_provider!.toLowerCase(),
      embeddingInfo.model_id,
      embeddingInfo?.config
    );

    const retriever = await createRetriever(bot, embeddingModel);

    const modelinfo = await getModelInfo({
      model: bot.model,
      prisma,
      type: "chat",
    });

    if (!modelinfo) {
      return handleErrorResponse(history, message, "Unable to find model");
    }

    const botConfig = getBotConfig(bot, modelinfo);
    const model = createChatModel(bot, bot.temperature, botConfig);

    const tools = [];
    if (bot.options && (bot.options as any).google_calendar) {
      const creds = (bot.options as any).google_calendar;
      if (creds.refresh_token && !creds.is_paused) {
        tools.push(createGoogleCalendarTool(creds));
        tools.push(cancelGoogleCalendarTool(creds));
        tools.push(rescheduleGoogleCalendarTool(creds));
      }
    }

    const chain = createChain({
      llm: model,
      question_llm: model,
      question_template: bot.questionGeneratorPrompt,
      response_template: bot.qaPrompt,
      retriever,
      tools,
    });

    const sanitizedQuestion = message.trim().replaceAll("\n", " ");
    const result = await chain.invoke({
      question: sanitizedQuestion,
      chat_history: groupMessagesByConversation(
        history.slice(-bot.noOfChatHistoryInContext).map((message) => ({
          type: message.type,
          content: message.text,
        }))
      ),
    });
    const botResponse = typeof result === "string" ? result : result.output || result;

    const documents = await retriever.getRelevantDocuments(sanitizedQuestion);
    const historyId = await saveChatHistory(
      prisma,
      bot.id,
      message,
      botResponse,
      history_id,
      documents
    );

    return {
      bot: { text: botResponse, sourceDocuments: documents },
      history: [
        ...history,
        { type: "human", text: message },
        { type: "ai", text: botResponse },
      ],
      history_id: historyId,
    };
  } catch (e) {
    console.error(e);
    return handleErrorResponse(
      history,
      message,
      "There was an error processing your request."
    );
  }
};

export const chatRequestStreamHandler = async (
  request: FastifyRequest<ChatRequestBody>,
  reply: FastifyReply
) => {
  const { id: bot_id } = request.params;
  const { message, history_id } = request.body;
  let history = [];

  try {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    
    const prisma = request.server.prisma;
    const bot = await prisma.bot.findFirst({
      where: { id: bot_id, user_id: request.user.user_id },
    });

    if (!bot) {
      reply.sse({ event: "chunk", id: "", data: JSON.stringify({ message: "You are in the wrong place, buddy." }) });
      reply.sse({ event: "result", id: "", data: JSON.stringify(handleErrorResponse(history, message, "You are in the wrong place, buddy.")) });
      await nextTick();
      return reply.raw.end();
    }


    if (history_id) {
      const details = await prisma.botPlayground.findFirst({
        where: {
          id: history_id,
          botId: bot_id,
        },
        include: {
          BotPlaygroundMessage: {
            orderBy: {
              createdAt: "asc",
            },
          },
        },
      });

      const botMessages = details?.BotPlaygroundMessage.map((message) => ({
        type: message.type,
        text: message.message,
      }));

      history = botMessages || [];
    }



    const embeddingInfo = await getModelInfo({
      model: bot.embedding,
      prisma,
      type: "embedding",
    });

    if (!embeddingInfo) {
      reply.sse({ event: "chunk", id: "", data: JSON.stringify({ message: "No embedding model found" }) });
      reply.sse({ event: "result", id: "", data: JSON.stringify(handleErrorResponse(history, message, "No embedding model found")) });
      await nextTick();
      return reply.raw.end();
    }

    const embeddingModel = embeddings(
      embeddingInfo.model_provider!.toLowerCase(),
      embeddingInfo.model_id,
      embeddingInfo?.config
    );

    const retriever = await createRetriever(bot, embeddingModel);

    const modelinfo = await getModelInfo({
      model: bot.model,
      prisma,
      type: "chat",
    });

    if (!modelinfo) {
      reply.sse({ event: "chunk", id: "", data: JSON.stringify({ message: "Not model found" }) });
      reply.sse({ event: "result", id: "", data: JSON.stringify(handleErrorResponse(history, message, "Not model found")) });
      await nextTick();
      return reply.raw.end();
    }

    const botConfig = getBotConfig(bot, modelinfo);
    const streamedModel = createChatModel(
      bot,
      bot.temperature,
      botConfig,
      true
    );
    const nonStreamingModel = createChatModel(bot, bot.temperature, botConfig);

    const tools = [];
    if (bot.options && (bot.options as any).google_calendar) {
      const creds = (bot.options as any).google_calendar;
      if (creds.refresh_token && !creds.is_paused) {
        tools.push(createGoogleCalendarTool(creds));
        tools.push(cancelGoogleCalendarTool(creds));
        tools.push(rescheduleGoogleCalendarTool(creds));
      }
    }

    const chain = createChain({
      llm: tools.length === 0 ? streamedModel : nonStreamingModel,
      question_llm: nonStreamingModel,
      question_template: bot.questionGeneratorPrompt,
      response_template: bot.qaPrompt,
      retriever,
      tools,
    });

    const sanitizedQuestion = message.trim().replaceAll("\n", " ");
    let response = "";
    if (tools.length === 0) {
      const stream = await chain.stream({
        question: sanitizedQuestion,
        chat_history: groupMessagesByConversation(
          history.slice(-bot.noOfChatHistoryInContext).map((message) => ({
            type: message.type,
            content: message.text,
          }))
        ),
      });

      for await (const token of stream) {
        reply.sse({
          id: "",
          event: "chunk",
          data: JSON.stringify({ message: token || "" }),
        });
        response += token;
      }
    } else {
      const result = await chain.invoke({
        question: sanitizedQuestion,
        chat_history: groupMessagesByConversation(
          history.slice(-bot.noOfChatHistoryInContext).map((message) => ({
            type: message.type,
            content: message.text,
          }))
        ),
      });
      response = typeof result === "string" ? result : result.output || result;
      // Send the entire response as a single chunk for simplicity when using tools
      reply.sse({
        id: "",
        event: "chunk",
        data: JSON.stringify({ message: response || "" }),
      });
    }

    const documents = await retriever.getRelevantDocuments(sanitizedQuestion);
    const historyId = await saveChatHistory(
      prisma,
      bot.id,
      message,
      response,
      history_id,
      documents
    );

    reply.sse({
      event: "result",
      id: "",
      data: JSON.stringify({
        bot: { text: response, sourceDocuments: documents },
        history: [
          ...history,
          { type: "human", text: message },
          { type: "ai", text: response },
        ],
        history_id: historyId,
      }),
    });

    await nextTick();
    return reply.raw.end();
  } catch (e: any) {
    console.error("Chat Stream Error:", e);
    const errorMessage = e.message || "Internal Server Error";
    
    reply.sse({
      id: "",
      event: "chunk",
      data: JSON.stringify({ message: `Error: ${errorMessage}` }),
    });
    
    reply.sse({
      event: "result",
      id: "",
      data: JSON.stringify({
        bot: { text: `Error: ${errorMessage}`, sourceDocuments: [] },
        history: [
          ...history,
          { type: "human", text: message },
          { type: "ai", text: `Error: ${errorMessage}` },
        ],
        history_id: history_id,
      }),
    });
    
    await nextTick();
    return reply.raw.end();
  }
};
