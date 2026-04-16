import { FastifyReply, FastifyRequest } from "fastify";
import { google } from "googleapis";

export const getGoogleOAuthClient = () => {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
};

export const googleCalendarAuthHandler = async (
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply
) => {
  const { id } = request.params;
  const prisma = request.server.prisma;

  const bot = await prisma.bot.findFirst({
    where: {
      id,
      user_id: request.user.user_id,
    },
  });

  if (!bot) {
    return reply.status(404).send({
      message: "Bot not found",
    });
  }

  const origin = request.headers.origin || request.headers.referer || process.env.VITE_HOST_URL || "http://localhost:5173";
  const hostUrl = new URL(origin).origin;
  
  const stateObj = { bot_id: id, hostUrl };
  const state = Buffer.from(JSON.stringify(stateObj)).toString('base64');

  const oauth2Client = getGoogleOAuthClient();
  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar.events"],
    state: state,
    prompt: "consent", // Force consent to ensure we get a refresh token
  });

  return reply.send({ url });
};

export const googleCalendarCallbackHandler = async (
  request: FastifyRequest<{ Querystring: { code: string; state: string } }>,
  reply: FastifyReply
) => {
  const { code, state } = request.query;
  const prisma = request.server.prisma;

  try {
    const stateObj = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
    const bot_id = stateObj.bot_id;
    const hostUrl = stateObj.hostUrl;

    const bot = await prisma.bot.findFirst({
      where: {
        id: bot_id,
      },
    });

    if (!bot) {
      return reply.status(404).send({
        message: "Bot not found",
      });
    }

    const oauth2Client = getGoogleOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    const options = (bot.options as any) || {};
    const newOptions = {
      ...options,
      google_calendar: {
        ...options.google_calendar,
        refresh_token: tokens.refresh_token || options.google_calendar?.refresh_token,
        access_token: tokens.access_token,
        expiry_date: tokens.expiry_date,
        is_paused: false,
      },
    };

    await prisma.bot.update({
      where: { id: bot.id },
      data: { options: newOptions },
    });

    // Redirect back to the frontend integration page
    return reply.redirect(`${hostUrl}/bot/${bot.id}/integrations`);
  } catch (error) {
    console.error("Error in Google Calendar OAuth callback:", error);
    return reply.status(500).send({ message: "Failed to authenticate with Google Calendar" });
  }
};
