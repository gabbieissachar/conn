'use strict';

// The app's settings, all from the environment (Replit "Secrets"). Nothing has a default that
// lets a stranger in: with no allow-list, no session secret or no OIDC client the app refuses to
// start, and the message names the variables, never their values.

const path = require('path');

const JUMPCLOUD = 'https://oauth.id.jumpcloud.com/';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function loadConfig(env = process.env) {
  const problems = [];
  const need = (name) => {
    const value = (env[name] || '').trim();
    if (!value) problems.push(`${name} is not set`);
    return value;
  };
  const appUrl = need('APP_URL').replace(/\/+$/, '');
  const clientId = need('OIDC_CLIENT_ID');
  const clientSecret = need('OIDC_CLIENT_SECRET');
  const sessionSecret = need('SESSION_SECRET');
  const allowed = need('ALLOWED_EMAILS').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);
  const issuer = (env.OIDC_ISSUER || JUMPCLOUD).trim();
  const secure = (url) => {
    try { const u = new URL(url); return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname)); } catch { return false; }
  };
  if (appUrl && !secure(appUrl)) problems.push('APP_URL must be an https address');
  if (!secure(issuer)) problems.push('OIDC_ISSUER must be an https address');
  if (sessionSecret && sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
  if (env.ALLOWED_EMAILS && !allowed.length) problems.push('ALLOWED_EMAILS has no email address');
  if (allowed.some((email) => !/^[^@\s]+@[^@\s]+$/.test(email))) problems.push('ALLOWED_EMAILS must be a comma-separated list of email addresses');
  if (problems.length) throw new Error('Not started: ' + problems.join('; ') + '.');
  return {
    appUrl, issuer, clientId, clientSecret, sessionSecret,
    allowedEmails: new Set(allowed),
    redirectUri: `${appUrl}/auth/callback`,
    secureCookies: appUrl.startsWith('https:'),
    sessionSeconds: Math.max(3600, (Number(env.SESSION_HOURS) || 168) * 3600),
    emailVerifiedOptional: env.OIDC_EMAIL_VERIFIED_OPTIONAL === '1',
    trustProxy: env.TRUST_PROXY === '1',
    queueLimit: 50,
    // The shell pages are code the owner deploys with the app; the upload key cannot replace them.
    shellDir: (env.SHELL_DIR || '').trim() || path.join(__dirname, 'shell'),
  };
}

module.exports = { loadConfig, JUMPCLOUD };
