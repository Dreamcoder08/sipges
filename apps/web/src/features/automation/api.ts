import {
  AutomationOverview,
  type ChannelIn,
  type ChannelKind,
  type RuleIn,
  TickReport,
} from '@sipges/contracts';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { requestJson } from '../../shared/api/client.ts';

export const overviewQuery = (scope: string) =>
  queryOptions({
    queryKey: ['automation', scope],
    queryFn: ({ signal }) =>
      requestJson('/system/automations', AutomationOverview, { scope, signal }),
  });

const Saved = z.object({ ok: z.literal(true), id: z.number().int().optional() });

export const saveRule = (scope: string, rule: RuleIn, id?: number) =>
  requestJson(id ? `/system/automations/rules/${id}` : '/system/automations/rules', Saved, {
    scope,
    method: id ? 'PUT' : 'POST',
    body: { json: rule },
  });

export const deleteRule = (scope: string, id: number) =>
  requestJson(`/system/automations/rules/${id}`, Saved, { scope, method: 'DELETE' });

export const createChannel = (scope: string, channel: ChannelIn) =>
  requestJson('/system/automations/channels', Saved, {
    scope,
    method: 'POST',
    body: { json: channel },
  });

export const deleteChannel = (scope: string, id: number) =>
  requestJson(`/system/automations/channels/${id}`, Saved, { scope, method: 'DELETE' });

export const testChannel = (scope: string, id: number) =>
  requestJson(`/system/automations/channels/${id}/test`, Saved, { scope, method: 'POST' });

export const tick = (scope: string) =>
  requestJson('/system/automations/tick', TickReport, { scope, method: 'POST' });

/** Settings each channel kind asks for, in form order. */
export const CHANNEL_FIELDS: Record<
  ChannelKind,
  {
    label: string;
    fields: readonly { key: string; label: string; hint?: string; secret?: boolean }[];
  }
> = {
  webhook: {
    label: 'Webhook firmado (n8n, Zapier, Make, Power Automate, sistemas propios)',
    fields: [
      { key: 'url', label: 'URL https del receptor' },
      {
        key: 'secret',
        label: 'Secreto de firma',
        hint: 'Mínimo 24 caracteres; el receptor verifica la cabecera webhook-signature.',
        secret: true,
      },
    ],
  },
  slack: {
    label: 'Slack',
    fields: [{ key: 'url', label: 'URL del webhook entrante de Slack', secret: true }],
  },
  teams: {
    label: 'Microsoft Teams',
    fields: [{ key: 'url', label: 'URL del flujo de trabajo de Teams', secret: true }],
  },
  discord: {
    label: 'Discord',
    fields: [{ key: 'url', label: 'URL del webhook de Discord', secret: true }],
  },
  gchat: {
    label: 'Google Chat',
    fields: [{ key: 'url', label: 'URL del webhook del espacio', secret: true }],
  },
  telegram: {
    label: 'Telegram',
    fields: [
      { key: 'bot_token', label: 'Token del bot', secret: true },
      { key: 'chat_id', label: 'ID del chat o @canal' },
    ],
  },
  email: {
    label: 'Correo electrónico (Resend)',
    fields: [
      { key: 'api_key', label: 'Clave de API de Resend', secret: true },
      {
        key: 'from',
        label: 'Remitente verificado',
        hint: 'Ejemplo: SIPGES <avisos@tu-dominio.org>',
      },
      { key: 'to', label: 'Destinatarios', hint: 'Separados por comas, hasta 20.' },
    ],
  },
};

export const OPERATOR_LABELS: Record<string, string> = {
  eq: 'es igual a',
  neq: 'es distinto de',
  contains: 'contiene',
  gte: 'es mayor o igual que',
  lte: 'es menor o igual que',
  present: 'tiene valor',
  absent: 'está vacío',
};

export const ACTION_LABELS: Record<string, string> = {
  CREATE: 'Creación',
  UPDATE: 'Actualización',
  DELETE: 'Eliminación',
  IMPORT: 'Importación',
  UPLOAD: 'Evidencia subida',
  CLASSIFY: 'Cambio de clasificación',
  REVIEW: 'Revisión',
  SNAPSHOT: 'Corte IRSA',
  CONFIG_UPDATE: 'Cambio de configuración',
};
