/**
 * Message event contract — real gateway payload samples.
 *
 * The platform ships additive fields before SDK type updates. This suite fixes
 * the rule: every mapped field is asserted here, and anything not mapped must
 * stay readable through `raw` without casting. When the gateway adds a field,
 * add it to the fixture first; the test then tells you whether it is mapped or
 * merely passed through.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dispatchEvent } from '../src/protocol/gateway/event-dispatcher.js';
import type { MessageResponse, OpenFields } from '../src/protocol/types.js';

const fixtures = JSON.parse(
  readFileSync(new URL('./fixtures/message-events.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, unknown>>;

function message(eventType: string, payload: Record<string, unknown>) {
  const result = dispatchEvent(eventType, payload, 'bot');
  if (result.action !== 'message') throw new Error(`expected a message, got ${result.action}`);
  return result.msg;
}

describe('message event contract', () => {
  it('maps the group sender avatar added by the gateway', () => {
    const msg = message('GROUP_AT_MESSAGE_CREATE', fixtures.group!);
    expect(msg.senderId).toBe('member-1');
    expect(msg.senderName).toBe('Alice');
    expect(msg.author.avatar).toBe('https://thirdqq.qlogo.cn/g?b=sdk&k=abc&s=140');
  });

  it('exposes the normalized author object for all scopes', () => {
    const group = message('GROUP_AT_MESSAGE_CREATE', fixtures.group!);
    expect(group.author).toEqual({
      id: 'member-1',
      name: 'Alice',
      isBot: false,
      avatar: 'https://thirdqq.qlogo.cn/g?b=sdk&k=abc&s=140',
    });
    expect(message('C2C_MESSAGE_CREATE', fixtures.c2c!).author.id).toBe('user-1');
    expect(message('AT_MESSAGE_CREATE', fixtures.guild!).author.name).toBe('Bob');
  });

  it('keeps unmapped author fields readable through raw', () => {
    const msg = message('GROUP_AT_MESSAGE_CREATE', fixtures.group!);
    const author = msg.raw.author as OpenFields;
    expect(author.region).toBe('cn-east');
  });

  it('maps avatars for c2c and guild messages too', () => {
    expect(message('C2C_MESSAGE_CREATE', fixtures.c2c!).author.avatar)
      .toBe('https://thirdqq.qlogo.cn/g?b=sdk&k=def&s=140');
    expect(message('AT_MESSAGE_CREATE', fixtures.guild!).author.avatar)
      .toBe('https://thirdqq.qlogo.cn/g?b=sdk&k=ghi&s=140');
  });

  it('keeps additive fields on attachments and mentions readable', () => {
    const msg = message('GROUP_AT_MESSAGE_CREATE', fixtures.group!);
    expect(msg.attachments?.[0]?.duration).toBe(12);
    expect(msg.mentions?.[0]?.is_new_member).toBe(true);
  });

  it('keeps additive fields on interaction events readable', () => {
    const result = dispatchEvent('INTERACTION_CREATE', fixtures.interaction!, 'bot');
    if (result.action !== 'interaction') throw new Error(`expected an interaction, got ${result.action}`);
    expect(result.event.data.resolved.new_flag).toBe(true);
  });

  it('accepts additive fields on HTTP response types', () => {
    // 编译期契约: undeclared response fields must not trip excess-property checks
    const response: MessageResponse = { id: 'm1', timestamp: 1, msg_seq: 2 };
    expect(response.msg_seq).toBe(2);
  });

  it('treats an empty, missing, or malformed avatar as absent', () => {
    expect(message('GROUP_AT_MESSAGE_CREATE', fixtures.groupWithoutAvatar!).author.avatar).toBeUndefined();
    const noAvatar = { ...fixtures.groupWithoutAvatar!, author: { member_openid: 'member-3' } };
    expect(message('GROUP_AT_MESSAGE_CREATE', noAvatar).author.avatar).toBeUndefined();
    const malformed = { ...fixtures.groupWithoutAvatar!, author: { member_openid: 'member-4', avatar: 123 } };
    expect(message('GROUP_AT_MESSAGE_CREATE', malformed).author.avatar).toBeUndefined();
  });
});
