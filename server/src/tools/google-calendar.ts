import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { google } from "googleapis";

export const createGoogleCalendarTool = (credentials: { refresh_token: string }) => {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({
    refresh_token: credentials.refresh_token,
  });

  const calendar = google.calendar({ version: "v3", auth: oauth2Client });

  return new DynamicStructuredTool({
    name: "schedule_appointment",
    description: "Schedules an appointment or event in Google Calendar. Provide the summary, start time, and end time in ISO 8601 format.",
    schema: z.object({
      summary: z.string().describe("The title or summary of the appointment"),
      description: z.string().optional().describe("Optional description of the appointment"),
      startTime: z.string().describe("Start time of the event in ISO 8601 format (e.g., 2026-04-16T10:00:00Z)"),
      endTime: z.string().describe("End time of the event in ISO 8601 format (e.g., 2026-04-16T11:00:00Z)"),
      attendeeEmail: z.string().optional().describe("Optional email address of the person to invite"),
    }) as any,
    func: async ({ summary, description, startTime, endTime, attendeeEmail }) => {
      try {
        const event: any = {
          summary,
          description,
          start: {
            dateTime: startTime,
            timeZone: "UTC",
          },
          end: {
            dateTime: endTime,
            timeZone: "UTC",
          },
        };

        if (attendeeEmail) {
          event.attendees = [{ email: attendeeEmail }];
        }

        const res = await calendar.events.insert({
          calendarId: "primary",
          requestBody: event,
          sendUpdates: "all",
        });

        return `Successfully scheduled appointment: ${res.data.htmlLink}`;
      } catch (error: any) {
        return `Failed to schedule appointment: ${error.message}`;
      }
    },
  });
};
