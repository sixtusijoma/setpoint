import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
  listDevices,
  parseMeterStatus,
  PRESS_COMMAND,
  pressBot,
  signSwitchBot,
  SwitchBotError,
} from '@/devices/switchbot';

const token = 'tok_fixed_value';
const secret = 'sec_fixed_value_should_not_leak';
const timestamp = '1700000000000';
const nonce = 'nonce-fixed';
const creds = { token, secret, timestamp, nonce };

describe('switchbot client', () => {
  it('matches Node HMAC-SHA256 for a fixed token, secret, timestamp, and nonce', () => {
    const expected = createHmac('sha256', secret)
      .update(token + timestamp + nonce)
      .digest('base64');
    expect(signSwitchBot({ token, secret, timestamp, nonce })).toBe(expected);
  });

  it('sends the press command shape exactly', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      return new Response(JSON.stringify({ statusCode: 100, body: {}, message: 'success' }), {
        status: 200,
      });
    });
    await pressBot(creds, 'BOT123', fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.switch-bot.com/v1.1/devices/BOT123/commands');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(PRESS_COMMAND);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(token);
    expect(headers.t).toBe(timestamp);
    expect(headers.nonce).toBe(nonce);
    expect(headers.sign).toBe(signSwitchBot({ token, secret, timestamp, nonce }));
  });

  it('parses MeterPro(CO2) status and converts 20°C to 68°F', () => {
    const reading = parseMeterStatus({
      deviceType: 'MeterPro(CO2)',
      temperature: 20,
      humidity: 47,
      CO2: 740,
      battery: 88,
    });
    expect(reading.temperatureF).toBe(68);
    expect(reading.humidity).toBe(47);
    expect(reading.co2Ppm).toBe(740);
    expect(reading.battery).toBe(88);
  });

  it('throws a useful error when statusCode is not 100', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ statusCode: 161, message: 'device offline', body: {} }),
        { status: 200 },
      );
    });
    await expect(listDevices(creds, fetchImpl)).rejects.toBeInstanceOf(SwitchBotError);
    try {
      await listDevices(creds, fetchImpl);
    } catch (error) {
      expect(error).toBeInstanceOf(SwitchBotError);
      if (error instanceof SwitchBotError) {
        expect(error.statusCode).toBe(161);
        expect(error.message).toContain('device offline');
        expect(error.message).toContain('161');
      }
    }
  });

  it('redacts the secret from request failures', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`network blew up ${secret}`);
    });
    try {
      await listDevices(creds, fetchImpl);
      throw new Error('expected a failure');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).toContain('[redacted]');
    }
  });

  it('redacts a secret echoed in an API error message', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({ statusCode: 190, message: `bad ${secret}`, body: {} }),
        { status: 200 },
      );
    });
    try {
      await pressBot(creds, 'BOT123', fetchImpl);
      throw new Error('expected a failure');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).not.toContain(secret);
      expect(message).toContain('[redacted]');
    }
  });
});
