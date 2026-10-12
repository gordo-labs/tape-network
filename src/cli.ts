#!/usr/bin/env node
/**
 * tape-network CLI: run a node on your own computer.
 *
 *   tape-network init [--name <name>]
 *   tape-network serve [--catalog <file.json>] [--publish] [--refresh <minutes>]
 *   tape-network id
 *   tape-network bootstrap add|remove <hexMeshId@ip:port>
 *   tape-network peers [list] | approve <peerId> | revoke <peerId> | block <peerId> | unblock <peerId>
 *   tape-network trust <peerId> <0..3>
 *   tape-network search (--mbid <id> | --isrc <code> | --title <t> --artist <a>)
 *   tape-network recommend (--mbid <id> | --artist <a> | --label <l> | --genre <g>) [--limit n]
 *
 * State lives in $TAPE_NETWORK_HOME (default ~/.tape-network).
 */
import { parseArgs } from 'node:util';
import { loadJsonCatalog } from './catalog/catalog.js';
import { TapeNetworkNode } from './node/node.js';
import type { LookupQuery, RecommendSeed } from './protocol/lookup.js';

const HELP = `tape-network — music metadata search and discovery over a sovereign Iroh mesh (metadata only, never audio)

Usage:
  tape-network init [--name <name>]                 create keys and config
  tape-network serve [--catalog <file>] [--publish] run the node (Ctrl+C to stop)
  tape-network id                                   print this node's ids and mesh address
  tape-network bootstrap add|remove <id@ip:port>    manage mesh entry points
  tape-network peers [list]                         discover peers through the mesh
  tape-network peers approve|revoke|block|unblock <peerId>
  tape-network trust <peerId> <weight 0..3>         local trust for consensus
  tape-network search --mbid <id> | --isrc <code> | --title <t> --artist <a>
  tape-network recommend --mbid <id> | --artist <a> | --label <l> | --genre <g> [--limit n]

Options:
  --json        machine-readable output
  --lan         accept private/LAN addresses in listings (home networks, tests)
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    name: { type: 'string' },
    catalog: { type: 'string' },
    publish: { type: 'boolean' },
    refresh: { type: 'string' },
    mbid: { type: 'string' },
    isrc: { type: 'string' },
    title: { type: 'string' },
    artist: { type: 'string' },
    label: { type: 'string' },
    genre: { type: 'string' },
    limit: { type: 'string' },
    json: { type: 'boolean' },
    lan: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

function out(value: unknown, text: () => string): void {
  console.log(values.json ? JSON.stringify(value, null, 2) : text());
}

function fail(message: string): never {
  console.error(`tape-network: ${message}`);
  process.exit(1);
}

function makeNode(): TapeNetworkNode {
  const node = new TapeNetworkNode({ allowPrivateAddrs: Boolean(values.lan) });
  const catalogPath = values.catalog ?? node.state.config.catalogPath;
  if (catalogPath) node.setCatalog(loadJsonCatalog(catalogPath));
  return node;
}

async function withNode<T>(fn: (node: TapeNetworkNode) => Promise<T>): Promise<T> {
  const node = makeNode();
  await node.start();
  try {
    return await fn(node);
  } finally {
    await node.stop();
  }
}

function query(): LookupQuery {
  if (values.mbid) return { identity: { type: 'musicbrainz-recording', value: values.mbid } };
  if (values.isrc) return { isrc: values.isrc };
  if (values.title && values.artist) return { title: values.title, artist: values.artist };
  return fail('search needs --mbid, --isrc, or --title with --artist');
}

function seed(): RecommendSeed {
  const s: RecommendSeed = {};
  if (values.mbid) s.identity = { type: 'musicbrainz-recording', value: values.mbid };
  if (values.artist) s.artist = values.artist;
  if (values.label) s.label = values.label;
  if (values.genre) s.genre = values.genre;
  if (values.title) s.title = values.title;
  if (!s.identity && !s.artist && !s.label && !s.genre) fail('recommend needs --mbid, --artist, --label or --genre');
  return s;
}

async function main(): Promise<void> {
  const [command, sub, arg, arg2] = positionals;
  if (values.help || !command || command === 'help') {
    console.log(HELP);
    return;
  }

  if (command === 'init') {
    const node = makeNode();
    if (values.name) node.state.config.name = values.name.slice(0, 128);
    if (values.catalog) node.state.config.catalogPath = values.catalog;
    node.state.saveConfig();
    out({ home: node.state.home, ...node.state.identity() }, () => `Initialized ${node.state.home}\nnode id: ${node.state.identity().hubId}`);
    return;
  }

  if (command === 'id') {
    const node = new TapeNetworkNode();
    const { lookupPeerId, meshEndpointHex } = node.state.offlineIds();
    const host = node.state.config.advertiseAddrs[0]?.replace(/:\d+$/, '') ?? '<your-public-ip>';
    const info = {
      nodeId: node.state.identity().hubId,
      lookupPeerId,
      meshAddress: `${meshEndpointHex}@${host}:${node.state.config.meshUdpPort}`,
    };
    out(info, () => [
      `node id:       ${info.nodeId}`,
      `lookup peer:   ${info.lookupPeerId}   (give this to peers you approve)`,
      `mesh address:  ${info.meshAddress}   (others can bootstrap from it)`,
    ].join('\n'));
    return;
  }

  if (command === 'bootstrap') {
    const node = new TapeNetworkNode();
    if (!arg || !/^[0-9a-f]{64}@.+:\d+$/i.test(arg)) fail('expected <hexMeshId@ip:port>');
    const set = new Set(node.state.config.bootstrapPeers);
    if (sub === 'add') set.add(arg.toLowerCase());
    else if (sub === 'remove') set.delete(arg.toLowerCase());
    else fail('bootstrap add|remove <id@ip:port>');
    node.state.config.bootstrapPeers = [...set].slice(0, 32);
    node.state.saveConfig();
    out(node.state.config.bootstrapPeers, () => node.state.config.bootstrapPeers.join('\n') || '(none)');
    return;
  }

  if (command === 'trust') {
    const weight = Number(arg);
    if (!sub || !Number.isFinite(weight) || weight < 0 || weight > 3) fail('trust <peerId> <weight 0..3>');
    const node = new TapeNetworkNode();
    node.state.config.trust[sub] = weight;
    node.state.saveConfig();
    out({ peerId: sub, weight }, () => `trust ${sub} = ${weight}`);
    return;
  }

  if (command === 'peers') {
    if (!sub || sub === 'list') {
      await withNode(async (node) => {
        await node.refresh();
        const peers = node.peers();
        out(peers, () => (peers.length
          ? peers.map((p) => `${p.approved ? '✓' : p.blocked ? '✗' : '·'} ${p.hubName}  ${p.peerId}  [${p.capabilities.join(', ')}]`).join('\n')
          : 'No peers found. Add a bootstrap peer: tape-network bootstrap add <id@ip:port>'));
      });
      return;
    }
    if (!arg) fail(`peers ${sub} <peerId>`);
    const node = new TapeNetworkNode();
    const config = node.state.config;
    const toggle = (list: string[], on: boolean) => (on ? [...new Set([...list, arg])] : list.filter((p) => p !== arg)).sort();
    if (sub === 'approve') config.approvedPeers = toggle(config.approvedPeers, true);
    else if (sub === 'revoke') config.approvedPeers = toggle(config.approvedPeers, false);
    else if (sub === 'block') { config.blockedPeers = toggle(config.blockedPeers, true); config.approvedPeers = toggle(config.approvedPeers, false); }
    else if (sub === 'unblock') config.blockedPeers = toggle(config.blockedPeers, false);
    else fail(`unknown peers command: ${sub}`);
    node.state.saveConfig();
    out({ approved: config.approvedPeers, blocked: config.blockedPeers }, () => `${sub}: ${arg}`);
    return;
  }

  if (command === 'search') {
    const q = query();
    await withNode(async (node) => {
      await node.refresh();
      const result = await node.search(q);
      out(result, () => (result.tracks.length
        ? result.tracks.map((t) => `${t.metadata.artist ?? '?'} — ${t.metadata.title ?? '?'}${t.metadata.album ? ` [${t.metadata.album}]` : ''}  (${t.matchedPeers} peers, title ${Math.round(t.consensus.title.confidence * 100)}%)`).join('\n')
        : `No matches from ${result.searchedPeers} approved peers.`));
    });
    return;
  }

  if (command === 'recommend') {
    const s = seed();
    const limit = values.limit ? Math.max(1, Math.min(50, Number(values.limit) || 25)) : 25;
    await withNode(async (node) => {
      await node.refresh();
      const ranked = await node.recommend(s, { limit });
      out(ranked, () => (ranked.length
        ? ranked.map((r) => `${r.score.toFixed(1)}  ${r.artist} — ${r.title}  (${r.reasons.join(', ')})\n      ${r.links.map((l) => `${l.service}: ${l.url}`).join('\n      ')}`).join('\n')
        : 'No recommendations yet: approve more peers or broaden the seed.'));
    });
    return;
  }

  if (command === 'serve') {
    const node = makeNode();
    if (values.publish) node.state.config.publishListing = true;
    await node.start();
    const refreshMs = Math.max(1, Number(values.refresh ?? 10)) * 60_000;
    const tick = () => node.refresh().catch((error: unknown) => console.error(`refresh failed: ${String(error)}`));
    await tick();
    const timer = setInterval(tick, refreshMs);
    console.log(`Tape Network node running (${node.state.config.publishListing ? 'listing published' : 'not listed'})`);
    console.log(`  lookup peer:  ${node.lookup.peerId()}`);
    console.log(`  mesh address: ${await node.meshAddress()}`);
    const shutdown = async () => {
      clearInterval(timer);
      await node.stop();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    return;
  }

  fail(`unknown command: ${command} (try --help)`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));
