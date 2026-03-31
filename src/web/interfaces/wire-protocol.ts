/**
 * WebSocket wire protocol negotiation.
 *
 * Sylphie supports two wire formats over WebSocket:
 *
 * - 'sylphie-native': camelCase DTOs (src/web/dtos/). Default. Used by the
 *   Sylphie dashboard frontend.
 * - 'cobeing-v1': snake_case shapes (src/web/adapters/cobeing-types.ts). Used
 *   by the co-being React frontend when connecting with ?protocol=cobeing-v1.
 *
 * Protocol is negotiated at connection time by reading the `protocol` query
 * parameter from the WebSocket upgrade URL. It is immutable for the lifetime
 * of the connection — there is no mid-session renegotiation.
 *
 * Gateways that need to support both protocols call getWireProtocol() in
 * handleConnection() and branch serialization accordingly. The domain logic
 * (CommunicationService, DriveEngine, etc.) is never aware of the protocol;
 * only the web layer adapts the output shape.
 */

/**
 * WireProtocol — discriminated union of supported wire format identifiers.
 *
 * 'sylphie-native' : Sylphie dashboard format (camelCase, src/web/dtos/).
 * 'cobeing-v1'     : co-being frontend format (snake_case, src/web/adapters/).
 */
export type WireProtocol = 'sylphie-native' | 'cobeing-v1';

/**
 * Extract the WireProtocol from a connected WebSocket client's URL.
 *
 * Reads the `protocol` query parameter from the upgrade URL. Falls back to
 * 'sylphie-native' when the parameter is absent, empty, or unrecognized.
 *
 * This function is intentionally forgiving: an unknown protocol string is
 * treated as 'sylphie-native' rather than an error, so clients that omit the
 * parameter continue to work without modification.
 *
 * @param client - The connected WebSocket client object from @nestjs/platform-ws.
 *   The function probes `client.url` and `client._url` to handle both the
 *   public API and the ws package's internal property. Both are expected to
 *   be the raw upgrade URL string (e.g., '/ws/telemetry?protocol=cobeing-v1').
 * @returns The negotiated WireProtocol for this connection.
 *
 * @example
 * // In a gateway's handleConnection:
 * handleConnection(client: unknown): void {
 *   const protocol = getWireProtocol(client);
 *   this.clientProtocols.set(client, protocol);
 * }
 */
/**
 * Extract the WireProtocol from the WebSocket upgrade request URL.
 *
 * With @nestjs/platform-ws, the upgrade URL lives on the HTTP IncomingMessage
 * passed as the second argument to handleConnection(client, req). The ws client
 * object itself does NOT carry the URL.
 *
 * @param req - The HTTP upgrade request (IncomingMessage), or the ws client as fallback.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getWireProtocol(req: any): WireProtocol {
  // Primary: req.url from the HTTP upgrade IncomingMessage
  // Fallback: probe client object locations across ws versions
  const url: string =
    (req?.url as string) ||
    (req?._req?.url as string) ||
    (req?.upgradeReq?.url as string) ||
    '';

  const queryString = url.includes('?') ? url.split('?')[1] : '';
  const params = new URLSearchParams(queryString);
  const raw = params.get('protocol');

  if (raw === 'cobeing-v1') {
    return 'cobeing-v1';
  }

  // 'sylphie-native' is both the default and the explicit value.
  return 'sylphie-native';
}
