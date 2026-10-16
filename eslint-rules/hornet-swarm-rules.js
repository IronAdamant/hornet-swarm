// Lint rules that keep three past mistake classes from coming back. AGENTS.md lists each rule
// beside the checks that enforce it.

const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

// Every call that can create a file, folder, or link, or change a mode. Reads, renames, and
// deletes stay allowed: they never leave a path more open than it was.
const FS_CREATORS = new Set([
  'appendFile',
  'appendFileSync',
  'chmod',
  'chmodSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'createWriteStream',
  'fchmod',
  'fchmodSync',
  'lchmod',
  'lchmodSync',
  'link',
  'linkSync',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'open',
  'openSync',
  'symlink',
  'symlinkSync',
  'writeFile',
  'writeFileSync',
]);

const SECURE_FS_HINT = 'Create files and folders through @hornet-swarm/core secure-fs (privateDir, writePrivateFile, writeRedactedFile, appendRedactedFile), which sets owner-only modes at creation and refuses links and foreign owners.';

const secureFsOnly = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid raw node:fs calls that create files, folders, or links, or change modes.' },
    messages: {
      creator: `'{{name}}' from node:fs makes a path with whatever mode the umask gives. ${SECURE_FS_HINT}`,
      umask: `process.umask changes the mode of every file this process makes. Use withSocketUmask from @hornet-swarm/core secure-fs.`,
    },
    schema: [],
  },
  create(context) {
    const namespaces = new Set();
    return {
      ImportDeclaration(node) {
        if (!FS_MODULES.has(String(node.source.value))) return;
        for (const specifier of node.specifiers) {
          if (specifier.type === 'ImportSpecifier') {
            const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value);
            if (FS_CREATORS.has(name)) context.report({ node: specifier, messageId: 'creator', data: { name } });
          } else {
            namespaces.add(specifier.local.name);
          }
        }
      },
      MemberExpression(node) {
        const name = memberName(node);
        if (!name) return;
        if (node.object.type === 'Identifier' && namespaces.has(node.object.name) && FS_CREATORS.has(name)) {
          context.report({ node, messageId: 'creator', data: { name } });
        }
        if (name === 'umask' && node.object.type === 'Identifier' && node.object.name === 'process') {
          context.report({ node, messageId: 'umask' });
        }
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
        const [first] = node.arguments;
        if (first?.type === 'Literal' && FS_MODULES.has(String(first.value))) {
          context.report({ node, messageId: 'creator', data: { name: 'require(fs)' } });
        }
      },
    };
  },
};

const UNSEALED_WRITERS = new Set(['writePrivateFile', 'appendPrivateFile', 'rewritePrivateFileInPlace', 'copyPrivateFile', 'copyPrivateTree']);
const SEALED_TYPES = new Set(['Redacted', 'RedactedBytes']);

const sealedArtifactsOnly = {
  meta: {
    type: 'problem',
    docs: { description: 'Artifact producers write only sealed content, and nothing casts to a sealed type.' },
    messages: {
      writer: `'{{name}}' writes unsealed bytes. A report or artifact must go through writeRedactedFile with content from Redactor.seal, Redactor.sealBytes, or fixedText.`,
      cast: `A cast to {{name}} skips the redaction check. Make the value with Redactor.seal, Redactor.sealBytes, or fixedText.`,
    },
    schema: [
      {
        type: 'object',
        properties: { forbidUnsealedWriters: { type: 'boolean' } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const forbidWriters = context.options[0]?.forbidUnsealedWriters === true;
    const checkCast = (node) => {
      const annotation = node.typeAnnotation;
      if (annotation?.type === 'TSTypeReference' && annotation.typeName.type === 'Identifier' && SEALED_TYPES.has(annotation.typeName.name)) {
        context.report({ node, messageId: 'cast', data: { name: annotation.typeName.name } });
      }
    };
    return {
      TSAsExpression: checkCast,
      TSTypeAssertion: checkCast,
      ImportDeclaration(node) {
        if (!forbidWriters) return;
        for (const specifier of node.specifiers) {
          if (specifier.type !== 'ImportSpecifier') continue;
          const name = specifier.imported.type === 'Identifier' ? specifier.imported.name : String(specifier.imported.value);
          if (UNSEALED_WRITERS.has(name)) context.report({ node: specifier, messageId: 'writer', data: { name } });
        }
      },
    };
  },
};

// Hosts a test may reach. Everything here is this machine, a container on it, or a name that
// can never resolve on the internet.
const OFFLINE_SUFFIXES = ['.test', '.invalid', '.localhost', '.example', '.local'];
const OFFLINE_NAMES = new Set(['localhost', 'host.docker.internal', '0.0.0.0', '::1', '[::1]']);

export function isOfflineHost(host) {
  const name = host.toLowerCase().replace(/\.$/, '');
  if (OFFLINE_NAMES.has(name)) return true;
  if (OFFLINE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return true;
  if (/^hornet-swarm-[a-z0-9-]+$/.test(name)) return true;
  if (/^127\.\d+\.\d+\.\d+$/.test(name)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(name) || /^192\.168\.\d+\.\d+$/.test(name)) return true;
  const private172 = /^172\.(\d+)\.\d+\.\d+$/.exec(name);
  return private172 !== null && Number(private172[1]) >= 16 && Number(private172[1]) <= 31;
}

export function liveHostIn(text) {
  const pattern = /\b(?:https?|wss?):\/\/(\[[^\]]+\]|[^/:?#\s'"`]+)/gi;
  for (const match of text.matchAll(pattern)) {
    const host = match[1];
    if (host.includes('${')) continue;
    if (!isOfflineHost(host)) return host;
  }
  const flag = /--(?:url|base-url|target)[ =]+(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/i.exec(text);
  if (flag && !isOfflineHost(flag[1])) return flag[1];
  return undefined;
}

// Calls that open a connection or load a page. A URL in any other place, such as a policy table
// under test, is data and stays allowed.
const NETWORK_CALLS = new Set(['fetch', 'goto', 'request', 'get', 'post', 'put', 'patch', 'delete', 'head', 'connect', 'newPage', 'waitForURL', 'execFileSync', 'execFile', 'execSync', 'exec', 'spawn', 'spawnSync']);
const NETWORK_CONSTRUCTORS = new Set(['WebSocket', 'EventSource', 'Request']);

const noLiveHostsInTests = {
  meta: {
    type: 'problem',
    docs: { description: 'Tests reach only the offline fixture, this machine, or names that cannot resolve.' },
    messages: {
      live: `This test would reach '{{host}}'. Tests use the offline fixture in test/fixture-app, 127.0.0.1, host.docker.internal, or a .test/.invalid/.example name only.`,
    },
    schema: [],
  },
  create(context) {
    const reportIn = (node, seen = new Set()) => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      const text = staticText(node, context, seen);
      if (text === undefined) return;
      const host = liveHostIn(text);
      if (host) context.report({ node, messageId: 'live', data: { host } });
    };
    const checkArguments = (args) => {
      for (const argument of args) {
        if (argument.type === 'ObjectExpression') {
          for (const property of argument.properties) {
            if (property.type !== 'Property') continue;
            const key = property.key.type === 'Identifier' ? property.key.name : String(property.key.value);
            if (key === 'url' || key === 'baseURL' || key === 'host' || key === 'hostname') {
              const text = staticText(property.value, context, new Set());
              if (text === undefined) continue;
              const host = key === 'host' || key === 'hostname' ? (isOfflineHost(text) ? undefined : text) : liveHostIn(text);
              if (host) context.report({ node: property.value, messageId: 'live', data: { host } });
            }
          }
        } else if (argument.type === 'ArrayExpression') {
          for (const element of argument.elements) reportIn(element);
        } else {
          reportIn(argument);
        }
      }
    };
    return {
      CallExpression(node) {
        const name = node.callee.type === 'Identifier' ? node.callee.name : node.callee.type === 'MemberExpression' ? memberName(node.callee) : undefined;
        if (name && NETWORK_CALLS.has(name)) checkArguments(node.arguments);
      },
      NewExpression(node) {
        if (node.callee.type === 'Identifier' && NETWORK_CONSTRUCTORS.has(node.callee.name)) checkArguments(node.arguments);
      },
    };
  },
};

function memberName(node) {
  if (node.computed) return node.property.type === 'Literal' ? String(node.property.value) : undefined;
  return node.property.type === 'Identifier' ? node.property.name : undefined;
}

/** The text of a literal, a template, a concatenation, or a const bound to one of those. */
function staticText(node, context, seen) {
  if (!node) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral') {
    return node.quasis.map((quasi, index) => quasi.value.cooked + (index < node.expressions.length ? (staticText(node.expressions[index], context, seen) ?? '${}') : '')).join('');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = staticText(node.left, context, seen);
    const right = staticText(node.right, context, seen);
    if (left === undefined && right === undefined) return undefined;
    return (left ?? '${}') + (right ?? '${}');
  }
  if (node.type === 'Identifier') {
    const variable = findVariable(context.sourceCode.getScope(node), node.name);
    const definition = variable?.defs[0];
    if (definition?.type !== 'Variable' || definition.parent.kind !== 'const') return undefined;
    const init = definition.node.init;
    if (!init || seen.has(init)) return undefined;
    seen.add(init);
    return staticText(init, context, seen);
  }
  return undefined;
}

function findVariable(scope, name) {
  for (let current = scope; current; current = current.upper) {
    const found = current.set.get(name);
    if (found) return found;
  }
  return undefined;
}

export default {
  meta: { name: 'hornet-swarm' },
  rules: {
    'secure-fs-only': secureFsOnly,
    'sealed-artifacts-only': sealedArtifactsOnly,
    'no-live-hosts-in-tests': noLiveHostsInTests,
  },
};
