// Loaded into every test process and, through NODE_OPTIONS, into every Node process a test starts.
// A connection to anything but this machine, a local container, or a name that cannot resolve on
// the internet throws before a packet leaves, so no test can reach a live site by accident.
import net from 'node:net';
import { isOfflineHost } from '../../eslint-rules/hornet-swarm-rules.js';

export class LiveHostError extends Error {
  constructor(host) {
    super(`A test tried to reach ${host}. Tests use the offline fixture in test/fixture-app only.`);
    this.name = 'LiveHostError';
  }
}

function targetHost(args) {
  const [first] = args;
  const options = Array.isArray(first) ? first[0] : first;
  if (options && typeof options === 'object') {
    if (options.path) return undefined;
    return options.host ?? options.hostname ?? 'localhost';
  }
  if (typeof first === 'string' && !/^\d+$/.test(first)) return undefined;
  return typeof args[1] === 'string' ? args[1] : 'localhost';
}

const original = net.Socket.prototype.connect;
if (!original.hornetSwarmOffline) {
  const guarded = function connect(...args) {
    const host = targetHost(args);
    if (host !== undefined && !isOfflineHost(String(host))) {
      const error = new LiveHostError(String(host));
      process.stderr.write(`${error.message}\n`);
      throw error;
    }
    return original.apply(this, args);
  };
  guarded.hornetSwarmOffline = true;
  net.Socket.prototype.connect = guarded;
}
