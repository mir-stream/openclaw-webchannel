/**
 * Unit tests for NATS user JWT generation (AC 3).
 *
 * Tests the core functionality of generating NATS user JWTs with
 * tenant-scoped permissions without requiring a real nats-server.
 */

import { describe, expect, it } from "vitest";
import { setupTrustChain } from "./setup-trust-chain.js";
import { DeviceFlowEnrollment } from "./device-flow-enrollment.js";

describe("NATS user JWT generation with tenant-scoped permissions (AC 3)", () => {
  it("should generate NATS user credentials with proper structure", async () => {
    // Generate trust chain
    const trustChain = await setupTrustChain({
      operatorName: "test-operator",
      accountName: "test-account",
    });

    // Create enrollment service
    const enrollment = new DeviceFlowEnrollment({
      saasTrustChain: trustChain.private,
      natsAccountConfig: trustChain.natsConfig,
      saasBaseUrl: "https://saas.test.com",
      jwksUrl: "https://saas.test.com/.well-known/jwks.json",
      bootstrapUrl: "https://saas.test.com/bootstrap",
    });

    // Create a mock enrollment
    const mockEnrollment = {
      device_code: "test-device-code",
      user_code: "TEST-1234",
      agentPublicKey: "test-public-key",
      agentId: "test-agent",
      tenant: "tenant-abc",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      status: "pending" as const,
    };

    // Generate credentials (access private method for testing)
    // @ts-ignore - accessing private method for testing
    const creds = await enrollment.generateNatsUserCredentials(mockEnrollment);

    // Verify structure
    expect(creds).toBeDefined();
    expect(creds.userJwt).toBeTruthy();
    expect(creds.userJwt).not.toBe("PLACEHOLDER_USER_JWT");
    expect(creds.userSeed).toBeTruthy();
    expect(creds.userSeed).toMatch(/^SU/); // User NKEY seed prefix (S=seed, U=user)
    expect(creds.permissions).toBeDefined();
    expect(creds.permissions?.pub).toEqual([
      "webchannel.tenant-abc.>",
    ]);
    expect(creds.permissions?.sub).toEqual([
      "webchannel.tenant-abc.>",
    ]);
  });

  it("should generate JWT with correct NATS claims structure", async () => {
    const trustChain = await setupTrustChain();

    const enrollment = new DeviceFlowEnrollment({
      saasTrustChain: trustChain.private,
      natsAccountConfig: trustChain.natsConfig,
      saasBaseUrl: "https://saas.test.com",
      jwksUrl: "https://saas.test.com/.well-known/jwks.json",
      bootstrapUrl: "https://saas.test.com/bootstrap",
    });

    const mockEnrollment = {
      device_code: "test-device-code",
      user_code: "TEST-1234",
      agentPublicKey: "test-public-key",
      agentId: "agent-123",
      tenant: "tenant-xyz",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      status: "pending" as const,
    };

    // @ts-ignore
    const creds = await enrollment.generateNatsUserCredentials(mockEnrollment);

    // Parse the JWT (without verifying signature for this test)
    const parts = creds.userJwt.split(".");
    expect(parts.length).toBe(3); // header.payload.signature

    // Decode payload
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );

    // Verify NATS JWT structure
    expect(payload.iss).toBeTruthy(); // Issuer (account NKEY)
    expect(payload.name).toBeTruthy(); // User name
    expect(payload.sub).toBeTruthy(); // Subject (user NKEY)
    expect(payload.nats).toBeDefined();
    expect(payload.nats.pub).toBeDefined();
    expect(payload.nats.pub.allow).toEqual([
      "webchannel.tenant-xyz.>",
    ]);
    expect(payload.nats.sub).toBeDefined();
    expect(payload.nats.sub.allow).toEqual([
      "webchannel.tenant-xyz.>",
    ]);
  });

  it("should generate unique user credentials for each enrollment", async () => {
    const trustChain = await setupTrustChain();

    const enrollment = new DeviceFlowEnrollment({
      saasTrustChain: trustChain.private,
      natsAccountConfig: trustChain.natsConfig,
      saasBaseUrl: "https://saas.test.com",
      jwksUrl: "https://saas.test.com/.well-known/jwks.json",
      bootstrapUrl: "https://saas.test.com/bootstrap",
    });

    const mockEnrollment1 = {
      device_code: "test-device-code-1",
      user_code: "TEST-1111",
      agentPublicKey: "test-public-key-1",
      agentId: "agent-1",
      tenant: "tenant-a",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      status: "pending" as const,
    };

    const mockEnrollment2 = {
      device_code: "test-device-code-2",
      user_code: "TEST-2222",
      agentPublicKey: "test-public-key-2",
      agentId: "agent-2",
      tenant: "tenant-a",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      status: "pending" as const,
    };

    // @ts-ignore
    const creds1 = await enrollment.generateNatsUserCredentials(mockEnrollment1);
    // @ts-ignore
    const creds2 = await enrollment.generateNatsUserCredentials(mockEnrollment2);

    // Verify uniqueness
    expect(creds1.userSeed).not.toBe(creds2.userSeed);
    expect(creds1.userJwt).not.toBe(creds2.userJwt);

    // Verify they have the same tenant-scoped permissions
    expect(creds1.permissions?.pub).toEqual(creds2.permissions?.pub);
    expect(creds1.permissions?.sub).toEqual(creds2.permissions?.sub);
  });

  it("should scope permissions to different tenants correctly", async () => {
    const trustChain = await setupTrustChain();

    const enrollment = new DeviceFlowEnrollment({
      saasTrustChain: trustChain.private,
      natsAccountConfig: trustChain.natsConfig,
      saasBaseUrl: "https://saas.test.com",
      jwksUrl: "https://saas.test.com/.well-known/jwks.json",
      bootstrapUrl: "https://saas.test.com/bootstrap",
    });

    const tenantAMock = {
      device_code: "test-device-code-a",
      user_code: "TEST-AAAA",
      agentPublicKey: "test-public-key-a",
      agentId: "agent-a",
      tenant: "tenant-alpha",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      status: "pending" as const,
    };

    const tenantBMock = {
      device_code: "test-device-code-b",
      user_code: "TEST-BBBB",
      agentPublicKey: "test-public-key-b",
      agentId: "agent-b",
      tenant: "tenant-beta",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      status: "pending" as const,
    };

    // @ts-ignore
    const credsA = await enrollment.generateNatsUserCredentials(tenantAMock);
    // @ts-ignore
    const credsB = await enrollment.generateNatsUserCredentials(tenantBMock);

    // Verify tenant-scoped permissions
    expect(credsA.permissions?.pub).toEqual([
      "webchannel.tenant-alpha.>",
    ]);
    expect(credsA.permissions?.sub).toEqual([
      "webchannel.tenant-alpha.>",
    ]);

    expect(credsB.permissions?.pub).toEqual([
      "webchannel.tenant-beta.>",
    ]);
    expect(credsB.permissions?.sub).toEqual([
      "webchannel.tenant-beta.>",
    ]);

    // Parse JWTs to verify tenant is in the claims
    const payloadA = JSON.parse(
      Buffer.from(credsA.userJwt.split(".")[1], "base64url").toString("utf8"),
    );
    const payloadB = JSON.parse(
      Buffer.from(credsB.userJwt.split(".")[1], "base64url").toString("utf8"),
    );

    const joinedA = [...payloadA.nats.pub.allow, ...payloadA.nats.sub.allow].join(" ");
    expect(joinedA).toContain("tenant-alpha");
    expect(joinedA).not.toContain("tenant-beta");

    const joinedB = [...payloadB.nats.pub.allow, ...payloadB.nats.sub.allow].join(" ");
    expect(joinedB).toContain("tenant-beta");
    expect(joinedB).not.toContain("tenant-alpha");
  });

  it("should generate user NKEY seeds with correct format", async () => {
    const trustChain = await setupTrustChain();

    const enrollment = new DeviceFlowEnrollment({
      saasTrustChain: trustChain.private,
      natsAccountConfig: trustChain.natsConfig,
      saasBaseUrl: "https://saas.test.com",
      jwksUrl: "https://saas.test.com/.well-known/jwks.json",
      bootstrapUrl: "https://saas.test.com/bootstrap",
    });

    const mockEnrollment = {
      device_code: "test-device-code",
      user_code: "TEST-1234",
      agentPublicKey: "test-public-key",
      tenant: "tenant-123",
      createdAt: Date.now(),
      expiresAt: Date.now() + 600000,
      status: "pending" as const,
    };

    // Generate multiple credentials to verify format consistency
    const seeds: string[] = [];
    for (let i = 0; i < 10; i++) {
      // @ts-ignore
      const creds = await enrollment.generateNatsUserCredentials(mockEnrollment);
      seeds.push(creds.userSeed);

      // Verify format
      expect(creds.userSeed).toMatch(/^SU/); // User NKEY seed prefix (S=seed, U=user)
      expect(creds.userSeed.length).toBeGreaterThan(20); // Substantial length
    }

    // Verify all seeds are unique
    const uniqueSeeds = new Set(seeds);
    expect(uniqueSeeds.size).toBe(seeds.length);
  });
});
