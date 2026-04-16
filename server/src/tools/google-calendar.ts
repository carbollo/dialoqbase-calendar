import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { google } from "googleapis";

async function checkConflicts(calendar: any, startTime: string, endTime: string) {
  const dateOnly = startTime.split('T')[0];
  const dayStart = `${dateOnly}T00:00:00Z`;
  const dayEnd = `${dateOnly}T23:59:59Z`;

  const dayEvents = await calendar.events.list({
    calendarId: "primary",
    timeMin: dayStart,
    timeMax: dayEnd,
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = dayEvents.data.items || [];
  
  const requestedStart = new Date(startTime).getTime();
  const requestedEnd = new Date(endTime).getTime();

  let hasConflict = false;
  const busyTimes: string[] = [];

  for (const e of events) {
    if (e.start?.dateTime && e.end?.dateTime) {
      const eStart = new Date(e.start.dateTime).getTime();
      const eEnd = new Date(e.end.dateTime).getTime();
      
      const sStr = new Date(eStart).toLocaleTimeString('es-ES', {timeZone: 'Europe/Madrid', hour: '2-digit', minute:'2-digit'});
      const eStr = new Date(eEnd).toLocaleTimeString('es-ES', {timeZone: 'Europe/Madrid', hour: '2-digit', minute:'2-digit'});
      busyTimes.push(`[${sStr} - ${eStr}]`);

      if (requestedStart < eEnd && requestedEnd > eStart) {
        hasConflict = true;
      }
    }
  }

  if (hasConflict) {
    return `ERROR: La hora solicitada ya está ocupada. NO confirmes la cita. Las siguientes horas están ocupadas este día: ${busyTimes.join(", ")}. Basándote en el horario comercial de tu contexto, sugiere al usuario la hora disponible más cercana ANTES y la más cercana DESPUÉS de la hora que pidió.`;
  }
  return null;
}

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
      startTime: z.string().describe("Start time of the event in ISO 8601 format WITH timezone offset (e.g., 2026-04-16T10:00:00+02:00)"),
      endTime: z.string().describe("End time of the event in ISO 8601 format WITH timezone offset (e.g., 2026-04-16T11:00:00+02:00)"),
    }) as any,
    func: async ({ customerName, phoneNumber, startTime, endTime }) => {
      try {
        const conflictError = await checkConflicts(calendar, startTime, endTime);
        if (conflictError) {
          return conflictError;
        }

        const event: any = {
          summary: `Cita: ${customerName}`,
          description: `Teléfono de contacto: ${phoneNumber}`,
          start: {
            dateTime: startTime,
          },
          end: {
            dateTime: endTime,
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

export const rescheduleGoogleCalendarTool = (credentials: { refresh_token: string }) => {
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
    name: "reschedule_appointment",
    description: "Reschedules an existing appointment in Google Calendar. Provide the customer's name, phone number, original date, and the new start and end times.",
    schema: z.object({
      customerName: z.string().describe("Nombre y apellidos del cliente / First and last name of the customer"),
      phoneNumber: z.string().describe("Número de teléfono del cliente / Phone number of the customer"),
      oldDate: z.string().describe("Fecha original de la cita en formato YYYY-MM-DD / Original date of the appointment in YYYY-MM-DD format"),
      newStartTime: z.string().describe("New start time of the event in ISO 8601 format WITH timezone offset (e.g., 2026-04-16T10:00:00+02:00)"),
      newEndTime: z.string().describe("New end time of the event in ISO 8601 format WITH timezone offset (e.g., 2026-04-16T11:00:00+02:00)"),
    }) as any,
    func: async ({ customerName, phoneNumber, oldDate, newStartTime, newEndTime }) => {
      try {
        const conflictError = await checkConflicts(calendar, newStartTime, newEndTime);
        if (conflictError) {
          return conflictError;
        }

        const now = new Date();
        const res = await calendar.events.list({
          calendarId: "primary",
          timeMin: now.toISOString(),
          q: phoneNumber,
          singleEvents: true,
          orderBy: "startTime",
        });

        const events = res.data.items;
        if (!events || events.length === 0) {
          return `No se encontró ninguna cita futura para el teléfono: ${phoneNumber}`;
        }

        const eventToReschedule = events.find(e => 
          (e.start?.dateTime && e.start.dateTime.startsWith(oldDate)) || 
          (e.start?.date && e.start.date.startsWith(oldDate))
        );

        if (!eventToReschedule) {
          return `No se encontró ninguna cita el día ${oldDate} para el cliente con teléfono ${phoneNumber}`;
        }
        
        eventToReschedule.start = {
          dateTime: newStartTime,
        };
        eventToReschedule.end = {
          dateTime: newEndTime,
        };
        eventToReschedule.summary = `Cita: ${customerName}`;
        eventToReschedule.description = `Teléfono de contacto: ${phoneNumber}`;

        await calendar.events.update({
          calendarId: "primary",
          eventId: eventToReschedule.id!,
          requestBody: eventToReschedule,
          sendUpdates: "all",
        });

        return `Cita reprogramada con éxito para el día ${newStartTime.split('T')[0]} a las ${newStartTime.split('T')[1]}`;
      } catch (error: any) {
        return `Failed to reschedule appointment: ${error.message}`;
      }
    },
  });
};
