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
    description: "Schedules an appointment or event in Google Calendar. Provide the customer's name, phone number, start time, and end time.",
    schema: z.object({
      customerName: z.string().describe("Nombre y apellidos del cliente / First and last name of the customer"),
      phoneNumber: z.string().describe("Número de teléfono del cliente / Phone number of the customer"),
      startTime: z.string().describe("Start time of the event in ISO 8601 format WITHOUT timezone (e.g., 2026-04-16T10:00:00)"),
      endTime: z.string().describe("End time of the event in ISO 8601 format WITHOUT timezone (e.g., 2026-04-16T11:00:00)"),
    }) as any,
    func: async ({ customerName, phoneNumber, startTime, endTime }) => {
      try {
        const event: any = {
          summary: `Cita: ${customerName}`,
          description: `Teléfono de contacto: ${phoneNumber}`,
          start: {
            dateTime: startTime,
            timeZone: "Europe/Madrid",
          },
          end: {
            dateTime: endTime,
            timeZone: "Europe/Madrid",
          },
        };

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

export const cancelGoogleCalendarTool = (credentials: { refresh_token: string }) => {
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
    name: "cancel_appointment",
    description: "Cancels an appointment or event in Google Calendar. Provide the customer's name, phone number, and the date of the appointment.",
    schema: z.object({
      customerName: z.string().describe("Nombre y apellidos del cliente / First and last name of the customer"),
      phoneNumber: z.string().describe("Número de teléfono del cliente / Phone number of the customer"),
      date: z.string().describe("Fecha de la cita en formato YYYY-MM-DD / Date of the appointment in YYYY-MM-DD format"),
    }) as any,
    func: async ({ customerName, phoneNumber, date }) => {
      try {
        const now = new Date();
        const res = await calendar.events.list({
          calendarId: "primary",
          timeMin: now.toISOString(),
          q: phoneNumber, // Buscamos por teléfono ya que es lo más único
          singleEvents: true,
          orderBy: "startTime",
        });

        const events = res.data.items;
        if (!events || events.length === 0) {
          return `No se encontró ninguna cita futura para el teléfono: ${phoneNumber}`;
        }

        // Filtramos para asegurarnos de que coincida con la fecha indicada
        const eventToCancel = events.find(e => 
          (e.start?.dateTime && e.start.dateTime.startsWith(date)) || 
          (e.start?.date && e.start.date.startsWith(date))
        );

        if (!eventToCancel) {
          return `No se encontró ninguna cita el día ${date} para el cliente con teléfono ${phoneNumber}`;
        }
        
        await calendar.events.delete({
          calendarId: "primary",
          eventId: eventToCancel.id!,
          sendUpdates: "all",
        });

        return `Cita cancelada con éxito: ${eventToCancel.summary} el día ${date}`;
      } catch (error: any) {
        return `Failed to cancel appointment: ${error.message}`;
      }
    },
  });
};
