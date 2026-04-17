import { FastifyReply, FastifyRequest } from "fastify";
import { chatRequestHandler } from "../../../../../controllers/bot/integration/apiwass.controller";

export const apiwassIntergationHandlerPost = async (
  request: FastifyRequest<{
    Params: {
      id: string;
    };
    Body: any;
  }>,
  reply: FastifyReply
) => {
  try {
    await chatRequestHandler(request, reply);
  } catch (error) {
    console.error("ApiWass Webhook Error:", error);
    return reply.status(500).send({
      message: "Internal Server Error",
    });
  }
};
