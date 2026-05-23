# Security Fix Plan

> Generated: 2026-05-23
> Status: Planning Phase

## Overview

This document outlines the security vulnerability remediation plan for Session Gateway v1. The fixes are prioritized by severity and organized into implementation phases.

## Risk Summary

| Severity | Count | Issues |
|----------|-------|--------|
| Critical | 3 | Weak default token, Runtime shell access, Plaintext API key |
| High | 5 | No rate limiting, Timing attack, Missing security headers, etc. |
| Low | 3 | Debug info leak, Edge case XSS |

---

## Phase 1: Critical Fixes (Immediate)

### 1.1 Fix Weak Authentication Default
**Priority**: P0 (Critical)
**File**: `src/config.mjs`
**Effort**: 1 hour

**Current Issue**:
```javascript
authToken: process.env.SESSION_GATEWAY_TOKEN ?? "dev-token",
```

**Solution**:
```javascript
authToken: (() => {
  const token = process.env.SESSION_GATEWAY_TOKEN;
  if (!token || token === "dev-token" || token === "change-me") {
    console.error("ERROR: SESSION_GATEWAY_TOKEN must be set to a secure random value");
    console.error("Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"");
    process.exit(1);
  }
  return token;
})(),
```

**Tasks**:
- [ ] Modify `src/config.mjs` to enforce token requirement
- [ ] Update `.env.example` with guidance
- [ ] Add startup validation
- [ ] Update tests to use proper tokens

---

### 1.2 Fix Timing Attack Vulnerability
**Priority**: P0 (Critical)
**File**: `src/auth.mjs`
**Effort**: 30 minutes

**Current Issue**:
```javascript
return authorization === `Bearer ${expectedToken}`;
```

**Solution**:
```javascript
import { timingSafeEqual } from "node:crypto";

export function isAuthorizedHeader(authorization, expectedToken) {
  const expected = `Bearer ${expectedToken}`;
  if (typeof authorization !== "string") {
    return false;
  }
  // Use constant-time comparison to prevent timing attacks
  if (authorization.length !== expected.length) {
    // Still do a comparison to maintain constant time
    timingSafeEqual(Buffer.alloc(expected.length), Buffer.from(expected, "utf8"));
    return false;
  }
  try {
    return timingSafeEqual(
      Buffer.from(authorization, "utf8"),
      Buffer.from(expected, "utf8")
    );
  } catch {
    return false;
  }
}
```

**Tasks**:
- [ ] Import `timingSafeEqual` from `node:crypto`
- [ ] Rewrite comparison logic
- [ ] Add unit tests for timing attack scenarios
- [ ] Benchmark to ensure no significant performance regression

---

### 1.3 Add Runtime Mode Security Warning
**Priority**: P0 (Critical)
**Files**: `src/config.mjs`, `src/server.mjs`, `CLAUDE.md`
**Effort**: 2 hours

**Current Issue**: Runtime mode allows arbitrary shell command execution without warnings.

**Solution**:
1. Add configuration option to disable runtime mode:
```javascript
// In config.mjs
allowRuntimeMode: process.env.SESSION_GATEWAY_ALLOW_RUNTIME === "true",
```

2. Add startup warning:
```javascript
// In server.mjs startup
if (config.allowRuntimeMode) {
  console.warn("WARNING: Runtime mode is ENABLED. Users can execute arbitrary shell commands.");
  console.warn("Set SESSION_GATEWAY_ALLOW_RUNTIME=false to disable.");
}
```

3. Validate in session creation:
```javascript
if (input.kind === "runtime" && !config.allowRuntimeMode) {
  throw new Error("Runtime mode is disabled on this server");
}
```

**Tasks**:
- [ ] Add `allowRuntimeMode` config option (default: false)
- [ ] Add startup warning banner
- [ ] Block runtime session creation when disabled
- [ ] Document security implications in README.md
- [ ] Add tests for disabled runtime mode

---

## Phase 2: High Priority Fixes

### 2.1 Add Rate Limiting
**Priority**: P1 (High)
**File**: `src/server.mjs`
**Effort**: 3 hours

**Solution**:
```javascript
// Simple in-memory rate limiter
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 100;

function checkRateLimit(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let requests = rateLimitStore.get(ip) || [];
  requests = requests.filter(t => t > windowStart);

  if (requests.length >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  requests.push(now);
  rateLimitStore.set(ip, requests);
  return true;
}

// Add to request handler
if (!checkRateLimit(clientIp)) {
  sendJson(res, 429, { error: "Too many requests" });
  return;
}
```

**Tasks**:
- [ ] Implement rate limiter module
- [ ] Add IP extraction from request (handle X-Forwarded-For)
- [ ] Add rate limit headers to responses (X-RateLimit-*)
- [ ] Add configuration for limits
- [ ] Add cleanup for old entries
- [ ] Write tests

---

### 2.2 Add Security HTTP Headers
**Priority**: P1 (High)
**File**: `src/server.mjs`
**Effort**: 1 hour

**Solution**:
```javascript
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()"
};

// For HTTPS
const SECURITY_HEADERS_HTTPS = {
  ...SECURITY_HEADERS,
  "Strict-Transport-Security": "max=31536000; includeSubDomains"
};

function sendJson(res, status, payload) {
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...SECURITY_HEADERS
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(payload));
}
```

**Tasks**:
- [ ] Define security headers constant
- [ ] Apply to `sendJson` function
- [ ] Apply to `sendText` function
- [ ] Apply to `serveStatic` function
- [ ] Add CSP for HTML responses
- [ ] Test headers are applied correctly

---

### 2.3 Protect API Key Storage
**Priority**: P1 (High)
**Files**: `src/config.mjs`, `src/server.mjs`
**Effort**: 2 hours

**Current Issue**: API key stored in plaintext JSON and returned by `/api/config`.

**Solution**:
1. Support environment variable for API key:
```javascript
// In normalizeCommandParser
apiKey: process.env.SESSION_GATEWAY_AI_API_KEY ??
  (typeof current.apiKey === "string" ? current.apiKey.trim() : "")
```

2. Exclude from API response:
```javascript
// In handleApi for /api/config
const safeSettings = {
  ...settings,
  commandParser: {
    ...settings.commandParser,
    apiKey: settings.commandParser?.apiKey ? "***" : ""
  }
};
sendJson(res, 200, { settings: safeSettings, enabled: config.runtimeSettingsEnabled });
```

**Tasks**:
- [ ] Add `SESSION_GATEWAY_AI_API_KEY` environment variable support
- [ ] Mask API key in `/api/config` response
- [ ] Update frontend to handle masked key
- [ ] Document the environment variable
- [ ] Add tests

---

### 2.4 Enhance Path Traversal Protection
**Priority**: P1 (High)
**File**: `src/server.mjs`
**Effort**: 1 hour

**Current Issue**: `startsWith` check doesn't handle symlinks.

**Solution**:
```javascript
import { realpath } from "node:fs/promises";

async function serveStatic(res, pathname, context) {
  const publicDir = context.publicDir;
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(publicDir, `.${safePath}`);

  try {
    // Resolve symlinks to prevent bypass
    const [resolvedPublic, resolvedFile] = await Promise.all([
      realpath(publicDir),
      realpath(filePath)
    ]);

    if (!resolvedFile.startsWith(resolvedPublic)) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }

    // ... rest of function
  } catch {
    sendJson(res, 404, { error: "Not found" });
  }
}
```

**Tasks**:
- [ ] Import `realpath` from `node:fs/promises`
- [ ] Resolve both publicDir and filePath before comparison
- [ ] Handle ENOENT and other errors gracefully
- [ ] Add tests with symlink scenarios

---

## Phase 3: Medium Priority

### 3.1 Add Audit Logging
**Priority**: P2 (Medium)
**Files**: New `src/logger.mjs`, `src/server.mjs`
**Effort**: 4 hours

**Solution**:
```javascript
// src/logger.mjs
import fs from "node:fs";
import path from "node:path";

export function createAuditLogger(logPath) {
  const stream = fs.createWriteStream(logPath, { flags: "a" });

  return {
    log(event) {
      const entry = {
        timestamp: new Date().toISOString(),
        ...event
      };
      stream.write(JSON.stringify(entry) + "\n");
    },

    close() {
      stream.end();
    }
  };
}
```

Log events:
- Authentication failures
- Session creation/deletion
- Command execution
- Configuration changes

**Tasks**:
- [ ] Create audit logger module
- [ ] Add logging to authentication failures
- [ ] Add logging to session operations
- [ ] Add logging to config changes
- [ ] Add log rotation strategy
- [ ] Document log format

---

### 3.2 Input Validation Hardening
**Priority**: P2 (Medium)
**Files**: Multiple
**Effort**: 3 hours

**Tasks**:
- [ ] Add maximum length validation for all string inputs
- [ ] Validate `cwd` path format
- [ ] Validate `name` doesn't contain path separators
- [ ] Add Unicode normalization for user input
- [ ] Add comprehensive input validation tests

---

## Phase 4: Documentation & Testing

### 4.1 Create SECURITY.md
**Priority**: P2 (Medium)
**Effort**: 2 hours

**Contents**:
- Security policy overview
- Supported versions
- Vulnerability reporting process
- Security best practices for deployment
- Known security considerations
- Security update history

**Tasks**:
- [ ] Create SECURITY.md file
- [ ] Document security features
- [ ] Document deployment best practices
- [ ] Add vulnerability reporting email/ process

---

### 4.2 Security Test Suite
**Priority**: P2 (Medium)
**Effort**: 4 hours

**Tests to add**:
- [ ] Timing attack resistance test
- [ ] Rate limiting test
- [ ] Path traversal test with symlinks
- [ ] Input validation edge cases
- [ ] Authentication bypass attempts
- [ ] XSS prevention test

---

## Implementation Timeline

| Phase | Duration | Dependencies |
|-------|----------|--------------|
| Phase 1 (Critical) | 1-2 days | None |
| Phase 2 (High) | 2-3 days | Phase 1 |
| Phase 3 (Medium) | 2-3 days | Phase 2 |
| Phase 4 (Documentation) | 1-2 days | Phase 3 |

**Total Estimated Effort**: 6-10 days

---

## Checklist Summary

### Critical (Must Fix Before Production)
- [ ] Fix weak default token
- [ ] Fix timing attack
- [ ] Add runtime mode warning/disable option

### High Priority
- [ ] Add rate limiting
- [ ] Add security headers
- [ ] Protect API key storage
- [ ] Enhance path traversal protection

### Medium Priority
- [ ] Add audit logging
- [ ] Harden input validation
- [ ] Create SECURITY.md
- [ ] Add security test suite

---

## Notes

1. **Backward Compatibility**: Some fixes may break existing deployments. Document migration steps clearly.

2. **Performance**: Rate limiting and realpath resolution add overhead. Benchmark critical paths.

3. **Configuration**: All security features should be configurable to allow gradual rollout.

4. **Testing**: Each fix should have corresponding test cases before merge.

---

*Document maintained by security audit process. Update as fixes are implemented.*
