/**
 * RFC 8628 Device Authorization Grant types for WebChannel plugin enrollment.
 *
 * This module defines the types for the device flow enrollment process where:
 *  1. Plugin initiates enrollment by calling /enroll
 *  2. Operator receives user_code and verification URI
 *  3. Operator approves enrollment at verification URI
 *  4. Plugin polls /poll until approval, receives NATS user credentials
 *
 * References:
 *  - RFC 8628: OAuth 2.0 Device Authorization Grant
 *  - OWASP: Device Code Flow Best Practices
 */

/**
 * Enrollment request from the plugin.
 *
 * The plugin sends its X25519 public key which will be registered with the
 * SaaS and included in the bootstrap JWT for verification.
 */
export type EnrollmentRequest = {
  /**
   * Plugin's X25519 public key (32 bytes, base64url-encoded).
   * This key will be:
   *  - Stored by SaaS as the agent's identity key
   *  - Included in the cnf.jwk claim of bootstrap JWTs
   *  - Used by browsers to verify E2E encrypted content
   */
  agentPublicKey: string;

  /**
   * Account (deployment) identifier — the wire identity (optional but recommended).
   * Useful for debugging and logging; not part of the trust chain.
   */
  accountId?: string;

  /**
   * Tenant identifier (required for multi-tenant SaaS).
   * Determines which NATS account the plugin will be enrolled into.
   */
  tenant: string;

  /**
   * Plugin package version (e.g. "0.1.8"), reported for diagnostics/audit.
   * OPTIONAL: a pre-reporting plugin omits it. Not part of the trust chain.
   */
  pluginVersion?: string;

  /**
   * Plugin wire-protocol version (see WEBCHANNEL_PROTOCOL_VERSION). OPTIONAL:
   * a pre-v1 plugin omits it. Advisory only — enrollment does not gate on it.
   */
  protocolVersion?: number;
};

/**
 * Enrollment response (RFC 8628 device authorization response).
 *
 * Returned by the /enroll endpoint. The plugin displays the user_code to the
 * operator (or encodes it in a QR code) and polls /poll for the result.
 */
export type EnrollmentResponse = {
  /**
   * Device code (opaque token, sent to /poll).
   * Must be kept secret by the plugin; transmitted only over TLS.
   * Format: base64url-encoded random bytes, recommended 32 bytes.
   */
  device_code: string;

  /**
   * User code (short, human-readable code for the operator).
   * Displayed to the operator; operator enters this at the verification URI.
   * Format: typically 8-12 characters from a reduced alphabet (e.g., BCDEGHKMNPQRSTVWXZ).
   */
  user_code: string;

  /**
   * Verification URI where the operator approves enrollment.
   * Complete with user_code query parameter: https://saas.com/enroll?user_code=ABCD-WXYZ
   */
  verification_uri: string;

  /**
   * Complete verification URI with user_code pre-filled.
   * Operator can click this link directly (no typing required).
   */
  verification_uri_complete: string;

  /**
   * Seconds until the device code expires (default 600 = 10 minutes).
   * After expiration, the plugin must restart enrollment with a new /enroll call.
   */
  expires_in: number;

  /**
   * Seconds the plugin should wait between polling attempts.
   * Minimum 5 seconds per RFC 8628; default 5 to avoid overwhelming the server.
   */
  interval: number;
};

/**
 * Poll request from the plugin.
 *
 * The plugin polls /poll with the device_code received from /enroll.
 */
export type PollRequest = {
  /**
   * Device code received from /enroll.
   * Must match a pending enrollment request.
   */
  device_code: string;
};

/**
 * Pending enrollment state stored by SaaS.
 *
 * Internal type (not exposed in API responses). SaaS stores this for each
 * pending enrollment until approval or expiration.
 */
export type PendingEnrollment = {
  /**
   * Device code (opaque token).
   */
  device_code: string;

  /**
   * User code (human-readable).
   */
  user_code: string;

  /**
   * Plugin's X25519 public key.
   */
  agentPublicKey: string;

  /**
   * Account (deployment) identifier — the wire identity (optional).
   */
  accountId?: string;

  /**
   * Tenant identifier.
   */
  tenant: string;

  /**
   * Timestamp when enrollment was created (milliseconds since epoch).
   */
  createdAt: number;

  /**
   * Expiration timestamp (milliseconds since epoch).
   */
  expiresAt: number;

  /**
   * Approval state.
   */
  status: "pending" | "approved" | "expired" | "denied";

  /**
   * Issued NATS user credentials (populated upon approval).
   */
  natsCreds?: NatsUserCredentials;

  /**
   * Issued peerId (bootstrap JWT subject).
   * Generated upon approval and used as the session routing key.
   */
  peerId?: string;
};

/**
 * NATS user credentials issued to the plugin.
 *
 * These credentials are returned to the plugin upon approval and stored
 * locally for reconnection. They contain a NATS user JWT signed by the
 * account NKEY from setupTrustChain.
 */
export type NatsUserCredentials = {
  /**
   * NATS user JWT (compact JWT string).
   * Contains subject permissions scoped to the tenant account.
   * Signed by the NATS account NKEY.
   */
  userJwt: string;

  /**
   * NATS user NKEY seed (e.g., "U...").
   * The plugin uses this to authenticate to NATS.
   */
  userSeed: string;

  /**
   * Minted user public NKEY (`U…`), identical to `userJwt.sub`. This is the
   * NATS revocation-ledger key: the SaaS refuses this exact credential by
   * adding `{ [userPubkey]: at }` to the account JWT's `revocations` map (see
   * addRevocation). Surfaced so consumers never hand-decode the JWT.
   */
  userPubkey: string;

  /**
   * NATS account/subject permissions for this user.
   * Defines which subjects the plugin can publish/subscribe to.
   */
  permissions?: {
    /**
     * Allowed publish subjects (NATS subject patterns with wildcards).
     * Example: "webchannel.>" for all WebChannel subjects.
     */
    pub?: string[];

    /**
     * Allowed subscribe subjects (NATS subject patterns with wildcards).
     * Example: "webchannel.inbound.>" for inbound messages.
     */
    sub?: string[];
  };
};

/**
 * Enrollment result returned by /poll upon approval.
 *
 * The plugin receives this after the operator approves the enrollment.
 * Contains everything needed to connect to NATS and identify itself.
 */
export type EnrollmentResult = {
  /**
   * NATS user credentials.
   */
  creds: NatsUserCredentials;

  /**
   * Peer ID (bootstrap JWT subject).
   * This is the unique session routing key for this plugin instance.
   * Generated by SaaS upon approval and included in bootstrap JWTs.
   */
  peerId: string;

  /**
   * SaaS JWKS endpoint URL (for bootstrap JWT verification).
   * Browsers use this to fetch the RSA public key for JWT verification.
   */
  jwksUrl: string;

  /**
   * SaaS bootstrap endpoint URL (for browser bootstrap JWT requests).
   * Browsers request bootstrap JWTs from this endpoint.
   */
  bootstrapUrl: string;

  /**
   * NATS WebSocket URL the plugin must dial to reach the relay.
   *
   * The SaaS is the rendezvous authority ("Lagrange point"): the relay URL is
   * NOT a plugin-side configuration value. The same SaaS that mints the NATS
   * user credentials (`creds`) also tells the plugin WHERE that relay lives, so
   * the credentials and their destination always travel together and can never
   * drift. The plugin consumes this in preference to any local
   * `nats.url` / `WEBCHANNEL_NATS_URL` (those remain dev-only overrides).
   */
  natsUrl: string;

  /**
   * The exact `iss` value this SaaS puts in the bootstrap JWTs it mints.
   *
   * Same rendezvous-authority principle as `natsUrl`: the issuer is a trust
   * fact MINTED by the SaaS (it may legitimately differ from the base URL
   * behind a reverse proxy / custom domain / logical issuer), so the SaaS
   * DECLARES it at enrollment instead of the plugin deriving it from the
   * base URL and hoping the two independent computations agree. The plugin
   * verifies bootstrap JWTs against THIS value (unless the operator pins
   * `auth.jwt.issuer` explicitly — pin > delivered > derived). Delivered and
   * consumed VERBATIM — never canonicalized on either side.
   */
  issuer: string;
};

/**
 * Poll response (RFC 8628 token response with custom fields).
 *
 * Returned by /poll. If enrollment is still pending, the server returns:
 *   HTTP 400 + { error: "authorization_pending" }
 * If approved, returns HTTP 200 + EnrollmentResult.
 * If denied/expired, returns HTTP 400 + error details.
 */
export type PollResponse =
  | EnrollmentResult // Success (HTTP 200)
  | { error: string; error_description?: string }; // Error (HTTP 400)

/**
 * Error responses (RFC 8628 Section 3.5 + custom errors).
 */
export type DeviceFlowError =
  | { error: "authorization_pending"; error_description?: string }
  | { error: "authorization_declined"; error_description?: string }
  | { error: "expired_token"; error_description?: string }
  | { error: "invalid_device_code"; error_description?: string }
  | { error: "access_denied"; error_description?: string };
