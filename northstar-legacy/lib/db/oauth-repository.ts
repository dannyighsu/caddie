import { query, queryOne } from "./client";

export type OAuthProvider = "google" | "notion" | "slack";

export interface OAuthCredential {
  id: string;
  user_id: string;
  provider: OAuthProvider;
  access_token: string;
  refresh_token: string | null;
  expires_at: Date | null;
  scopes: string[] | null;
  metadata: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertOAuthCredentialInput {
  userId?: string;
  provider: OAuthProvider;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: Date | null;
  scopes?: string[] | null;
  metadata?: Record<string, unknown>;
}

export async function upsertOAuthCredential(
  input: UpsertOAuthCredentialInput
): Promise<OAuthCredential> {
  const userId = input.userId || "default";

  const result = await queryOne<OAuthCredential>(
    `
    INSERT INTO oauth_credentials (user_id, provider, access_token, refresh_token, expires_at, scopes, metadata)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (user_id, provider)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_credentials.refresh_token),
      expires_at = EXCLUDED.expires_at,
      scopes = COALESCE(EXCLUDED.scopes, oauth_credentials.scopes),
      metadata = oauth_credentials.metadata || EXCLUDED.metadata,
      updated_at = NOW()
    RETURNING *
    `,
    [
      userId,
      input.provider,
      input.accessToken,
      input.refreshToken || null,
      input.expiresAt || null,
      input.scopes || null,
      JSON.stringify(input.metadata || {}),
    ]
  );

  if (!result) {
    throw new Error("Failed to upsert OAuth credential");
  }

  return result;
}

export async function getOAuthCredential(
  provider: OAuthProvider,
  userId: string = "default"
): Promise<OAuthCredential | null> {
  return queryOne<OAuthCredential>(
    `SELECT * FROM oauth_credentials WHERE user_id = $1 AND provider = $2`,
    [userId, provider]
  );
}

export async function getAllOAuthCredentials(
  userId: string = "default"
): Promise<OAuthCredential[]> {
  return query<OAuthCredential>(
    `SELECT * FROM oauth_credentials WHERE user_id = $1 ORDER BY provider`,
    [userId]
  );
}

export async function deleteOAuthCredential(
  provider: OAuthProvider,
  userId: string = "default"
): Promise<boolean> {
  const result = await query(
    `DELETE FROM oauth_credentials WHERE user_id = $1 AND provider = $2 RETURNING id`,
    [userId, provider]
  );
  return result.length > 0;
}

export async function updateOAuthTokens(
  provider: OAuthProvider,
  accessToken: string,
  expiresAt: Date | null,
  refreshToken?: string | null,
  userId: string = "default"
): Promise<OAuthCredential | null> {
  return queryOne<OAuthCredential>(
    `
    UPDATE oauth_credentials
    SET
      access_token = $3,
      expires_at = $4,
      refresh_token = COALESCE($5, refresh_token),
      updated_at = NOW()
    WHERE user_id = $1 AND provider = $2
    RETURNING *
    `,
    [userId, provider, accessToken, expiresAt, refreshToken]
  );
}
