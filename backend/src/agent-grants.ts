import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createGrantCredential, grantCommitment } from '@near-intents-agent-api/sdk';

const context = (agentId: string, commitment: string) =>
  Buffer.from(`dragons-market.agent-grant.v1:${agentId}:${commitment}`);

export function sealNewGrant(key: Buffer, agentId: string) {
  const { token, commitment } = createGrantCredential(), iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(context(agentId, commitment));
  const sealed = Buffer.concat([iv, cipher.update(token, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return { token, commitment, sealed };
}

export function openGrant(key: Buffer, agentId: string, commitment: string, sealed: Buffer | null): string | null {
  if (!sealed || sealed.length < 12 + 16) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12), { authTagLength: 16 })
      .setAAD(context(agentId, commitment)).setAuthTag(sealed.subarray(sealed.length - 16));
    const token = Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()])
      .toString('utf8');
    return grantCommitment(token) === commitment ? token : null;
  } catch {
    return null;
  }
}
