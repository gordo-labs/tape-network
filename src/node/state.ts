/**
 * Node state under TAPE_NETWORK_HOME (default ~/.tape-network): keys (0600) and config.
 * Identities are separate on purpose: Nostr key (mesh events), Ed25519 node identity
 * (binding, like a Hub's Sovereign identity), lookup Iroh key, and the mesh Iroh key
 * (mesh-iroh-key.bin, the same file a Hub uses).
 */
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { generateNostrSecretKey, irohEndpointIdFromHex, meshBytesToHex, meshHexToBytes, meshHubIdFromPublicKey } from '../protocol/mesh.js';
import { DEFAULT_MESH_UDP_PORT as HUB_MESH_UDP_PORT, loadOrCreateMeshNodeKey } from './mesh.js';

/** Hubs use 42425/tcp + 42426/udp; a standalone node defaults next to them so both can run on one machine. */
export const DEFAULT_NODE_MESH_UDP_PORT = HUB_MESH_UDP_PORT + 10;
export const DEFAULT_NODE_LOOKUP_UDP_PORT = HUB_MESH_UDP_PORT + 11;

export type NodeConfig = {
  name: string | null;
  /** Mesh peers to join: "<hex mesh endpoint id>@<ip:port>". */
  bootstrapPeers: string[];
  /** Peers (base32 lookup endpoint ids) allowed to query this node, and that this node queries. */
  approvedPeers: string[];
  blockedPeers: string[];
  /** Local trust multipliers for consensus, by peer id. */
  trust: Record<string, number>;
  /** Publish a discovery listing on the mesh (opt-in). */
  publishListing: boolean;
  lookupUdpPort: number;
  meshUdpPort: number;
  bindHost: string;
  /** Public ip:port candidates to advertise for the lookup endpoint (optional). */
  advertiseAddrs: string[];
  relayUrls: string[];
  catalogPath: string | null;
};

type Keys = { v: 1; nostr: string; identityPrivate: string; identityPublic: string; lookupIroh: string };

export const DEFAULT_CONFIG: NodeConfig = {
  name: null,
  bootstrapPeers: [],
  approvedPeers: [],
  blockedPeers: [],
  trust: {},
  publishListing: false,
  lookupUdpPort: DEFAULT_NODE_LOOKUP_UDP_PORT,
  meshUdpPort: DEFAULT_NODE_MESH_UDP_PORT,
  bindHost: '0.0.0.0',
  advertiseAddrs: [],
  relayUrls: [],
  catalogPath: null,
};

function writePrivate(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try { chmodSync(path, 0o600); } catch { /* windows */ }
}

export function resolveHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.TAPE_NETWORK_HOME ?? join(homedir(), '.tape-network');
}

export class NodeState {
  readonly home: string;
  private keys: Keys;
  config: NodeConfig;

  constructor(home = resolveHome()) {
    this.home = home;
    mkdirSync(home, { recursive: true });
    this.keys = this.loadKeys();
    this.config = this.loadConfig();
  }

  private loadKeys(): Keys {
    const path = join(this.home, 'keys.json');
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, 'utf8')) as Keys;
      if (raw.v === 1 && /^[0-9a-f]{64}$/.test(raw.nostr)) return raw;
    }
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const keys: Keys = {
      v: 1,
      nostr: meshBytesToHex(generateNostrSecretKey()),
      identityPrivate: (privateKey.export({ format: 'jwk' }) as { d: string }).d,
      identityPublic: (publicKey.export({ format: 'jwk' }) as { x: string }).x,
      lookupIroh: meshBytesToHex(crypto.getRandomValues(new Uint8Array(32))),
    };
    writePrivate(path, keys);
    return keys;
  }

  private loadConfig(): NodeConfig {
    const path = join(this.home, 'config.json');
    if (!existsSync(path)) {
      writePrivate(path, DEFAULT_CONFIG);
      return { ...DEFAULT_CONFIG };
    }
    return { ...DEFAULT_CONFIG, ...(JSON.parse(readFileSync(path, 'utf8')) as Partial<NodeConfig>) };
  }

  saveConfig(): void {
    writePrivate(join(this.home, 'config.json'), this.config);
  }

  nostrSecretKey(): Uint8Array { return meshHexToBytes(this.keys.nostr); }
  lookupIrohKey(): Uint8Array { return meshHexToBytes(this.keys.lookupIroh); }

  /** Ids derivable without starting the node: the lookup peer id (base32) and the mesh endpoint id (hex). */
  offlineIds(): { lookupPeerId: string; meshEndpointHex: string } {
    const lookupHex = meshBytesToHex(ed25519.getPublicKey(this.lookupIrohKey()));
    const meshEndpointHex = meshBytesToHex(ed25519.getPublicKey(loadOrCreateMeshNodeKey(this.home)));
    return { lookupPeerId: irohEndpointIdFromHex(lookupHex, 'base32') ?? lookupHex, meshEndpointHex };
  }

  /** Node identity, the same shape as a Tape Hub's Sovereign identity (for mesh bindings). */
  identity(): { hubId: string; publicKey: string } {
    return { hubId: meshHubIdFromPublicKey(this.keys.identityPublic), publicKey: this.keys.identityPublic };
  }

  signWithIdentity(message: Uint8Array): string {
    const key = createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', d: this.keys.identityPrivate, x: this.keys.identityPublic },
      format: 'jwk',
    });
    return sign(null, message, key).toString('base64url');
  }
}
