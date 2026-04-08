import path from "node:path";
import { STATE_DIR } from "../../config/paths.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { SandboxDockerConfig } from "./types.docker.js";

const log = createSubsystemLogger("docker");

/**
 * Translates a gateway-internal path to its host-side equivalent by replacing
 * the gateway path prefix with the host path prefix.
 *
 * Used when the gateway runs inside a container (e.g. Podman) and needs to
 * pass bind-mount source paths that resolve on the host filesystem.
 */
export function translateToHostPath(params: {
  gatewayPath: string;
  gatewayPrefix: string;
  hostPrefix: string;
}): string {
  const { gatewayPath, gatewayPrefix, hostPrefix } = params;
  const normalizedGateway = path.resolve(gatewayPath);
  const normalizedPrefix = path.resolve(gatewayPrefix);

  if (!normalizedGateway.startsWith(normalizedPrefix)) {
    log.warn(
      `Path "${gatewayPath}" does not start with gateway prefix "${gatewayPrefix}"; passing through untranslated`,
    );
    return gatewayPath;
  }

  const suffix = normalizedGateway.slice(normalizedPrefix.length);
  return path.join(hostPrefix, suffix);
}

/**
 * Creates a path translator function from the Docker sandbox config.
 * Returns null when hostPathPrefix is not configured (no translation needed).
 */
export function createHostPathTranslator(
  docker: SandboxDockerConfig,
): ((gatewayPath: string) => string) | null {
  const hostPrefix = docker.hostPathPrefix?.trim();
  if (!hostPrefix) {
    return null;
  }
  const gatewayPrefix = docker.gatewayPathPrefix?.trim() || STATE_DIR;
  return (gatewayPath: string) =>
    translateToHostPath({ gatewayPath, gatewayPrefix, hostPrefix });
}
