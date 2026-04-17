import { FastifyPluginAsync } from "fastify";
import {
  createIntergationHandler,
  pauseOrResumeIntergationHandler,
} from "../../../../../handlers/api/v1/bot/integration/post.handler";
import {
  createIntergationSchema,
  generateAPIKeySchema,
  getAPIIntegrationSchema,
  pauseOrResumeIntergationSchema,
  regenerateAPIKeySchema,
} from "../../../../../schema/api/v1/bot/integration";

import {
  whatsappIntergationHandler,
  whatsappIntergationHandlerPost,
} from "../../../../../handlers/api/v1/bot/integration/whatsapp.handler";

import {
  generateAPIKeyHandler,
  getAPIIntegrationHandler,
  regenerateAPIKeyHandler,
} from "../../../../../handlers/api/v1/bot/integration/api.handler";
import { getChannelsByProvider } from "../../../../../handlers/api/v1/bot/integration/get.handler";
import {
  googleCalendarAuthHandler,
  googleCalendarCallbackHandler,
} from "../../../../../handlers/api/v1/bot/integration/google.handler";

import {
  apiwassIntergationHandlerPost,
} from "../../../../../handlers/api/v1/bot/integration/apiwass.handler";

const root: FastifyPluginAsync = async (fastify, _): Promise<void> => {
  // create integration for channel
  fastify.post(
    "/:id",
    {
      schema: createIntergationSchema,
      onRequest: [fastify.authenticate],
    },
    createIntergationHandler
  );
  // pause or resume integration
  fastify.post(
    "/:id/toggle",
    {
      schema: pauseOrResumeIntergationSchema,
      onRequest: [fastify.authenticate],
    },
    pauseOrResumeIntergationHandler
  );

  // return all bot channels
  fastify.get(
    "/:id",
    {
      schema: {
        tags: ["Bot", "Integration"],
        summary: "Get all bot channels",
        headers: {
          type: "object",
          properties: {
            Authorization: { type: "string" },
          },
          required: ["Authorization"],
        },
      },
      onRequest: [fastify.authenticate],
    },
    getChannelsByProvider
  );

  // whatsapp integration
  fastify.get(
    "/:id/whatsapp",
    {
      schema: {
        hide: true,
      },
    },
    whatsappIntergationHandler
  );
  fastify.post(
    "/:id/whatsapp",
    {
      schema: {
        hide: true,
      },
    },
    whatsappIntergationHandlerPost
  );

  // api key integration
  fastify.get(
    "/:id/api",
    {
      schema: getAPIIntegrationSchema,
      onRequest: [fastify.authenticate],
    },
    getAPIIntegrationHandler
  );

  // generate api key
  fastify.post(
    "/:id/api",
    {
      schema: generateAPIKeySchema,
      onRequest: [fastify.authenticate],
    },
    generateAPIKeyHandler
  );

  // regenerate api key
  fastify.put(
    "/:id/api",
    {
      schema: regenerateAPIKeySchema,
      onRequest: [fastify.authenticate],
    },
    regenerateAPIKeyHandler
  );

  // apiwass global webhook
  fastify.post(
    "/apiwass/webhook",
    {
      schema: {
        hide: true,
      },
    },
    apiwassIntergationHandlerPost
  );

  // apiwass integration webhook
  fastify.post(
    "/:id/apiwass",
    {
      schema: {
        hide: true,
      },
    },
    apiwassIntergationHandlerPost
  );

  // google calendar oauth
  fastify.get(
    "/:id/google_calendar/auth",
    {
      schema: { hide: true },
      onRequest: [fastify.authenticate],
    },
    googleCalendarAuthHandler
  );

  fastify.get(
    "/google_calendar/callback",
    {
      schema: { hide: true },
    },
    googleCalendarCallbackHandler
  );
};

export default root;
