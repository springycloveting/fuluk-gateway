export function isAuthorizedHeader(authorization, expectedToken) {
  return authorization === `Bearer ${expectedToken}`;
}
