import { spawn, execFile, type ChildProcess } from 'child_process';
import { constants, promises as fs } from 'fs';
import { createConnection, type Socket } from 'net';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import type { SessionConfiguration } from './configuration';
import type { EngineEvents } from './engine-process';
import { decodePage, decodeText, SourcePoints } from './flashtex-protocol';
import { terminate } from './process-lifecycle';
import type { Command } from './protocol';
import { isImageHeader, MAX_IMAGE_BYTES } from './preview-protocol';

const exec = promisify(execFile);
const inside = (root: string, file: string) => {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};
const excluded = new Set(['.git', '.vscode', 'node_modules']);

type Done = {
  id: number; status: string; mode: string; keep: boolean; pages: number; restart_page?: number;
  converged_at?: number; typeset_pages?: number; pdf?: string; elapsed_ms: number;
};
export type WatchProject = (root: string, onChange: (file: string) => void) => { dispose(): void };

export class FlashtexEngine {
  private directory?: string;
  private child?: ChildProcess;
  private socket?: Socket;
  private watcher?: { dispose(): void };
  private stopping = false;
  private paused = false;
  private timer?: ReturnType<typeof setTimeout>;
  private launch?: Promise<void>;
  private compiling?: Promise<void>;
  private shutdown?: Promise<void>;
  private abort = new AbortController();
  private renderers = new Set<Promise<void>>();
  private points = new SourcePoints();
  private announced = new Set<string>();
  private buffers = new Map<string, Buffer>();
  private bufferChanges = new Set<string>();
  private diskChanges = new Set<string>();
  private diagnostics: string[] = [];
  private pending = false;
  private ready = false;
  private inFlight = false;
  private id = 0;
  private pid?: number;
  private sequence = 0;
  private requestedSequence = 0;
  private revision = 0;
  private pageCount = 0;
  private forward?: [string, number];
  private published?: string;
  private project: string;
  private mainDirectory: string;
  private mirror = '';
  private root = '';
  private output = '';
  stderrTail = '';

  constructor(private events: EngineEvents, private config: SessionConfiguration, private main: string,
    parent: string | undefined, private watchProject?: WatchProject) {
    this.mainDirectory = path.dirname(main);
    this.project = parent && inside(parent, main) ? parent : this.mainDirectory;
  }

  get active(): boolean { return !!this.launch && !this.stopping; }

  start(): Promise<void> {
    this.launch = this.startHost();
    return this.launch;
  }

  private async startHost(): Promise<void> {
    if (process.platform === 'win32') {throw Error('FlashTeX preview currently requires a local macOS or Linux extension host.');}
    // A short, private socket path also leaves room under macOS's 104-byte limit.
    this.directory = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'txp-ft-'));
    this.mirror = path.join(this.directory, 'project');
    this.root = this.copyPath(this.mainDirectory);
    this.output = path.join(this.directory, 'output');
    if (this.config.watchDependencies) {this.watcher = this.watchProject?.(this.project, file => {
      if (!this.isProjectFile(file)) {return;}
      this.diskChanges.add(file);
      if (!this.buffers.has(file)) {this.schedule();}
    });}
    await this.copyTree(this.project, true);
    await fs.mkdir(this.output);
    if (this.stopping) {return;}
    const sock = path.join(this.directory, 'host.sock');
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: '/Library/TeX/texbin:' + (process.env.PATH || '') };
    const include = this.config.includeDirectories.map(dir => path.resolve(this.mainDirectory, dir))
      .map(dir => inside(this.project, dir) ? this.copyPath(dir) : dir);
    if (include.length) {env.TEXINPUTS = [...include, process.env.TEXINPUTS || ''].join(path.delimiter);}
    const executable = this.config.flashtexHost || 'flashtex-host';
    const args = ['--socket', sock, '--once', '--accept-timeout', '45', '--no-warm'];
    this.events.debug('Starting FlashTeX: ' + JSON.stringify([executable, ...args]));
    const child = spawn(executable, args, { cwd: this.directory, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', (data: Buffer) => this.events.debug(data.toString('utf8')));
    child.stderr?.on('data', (data: Buffer) => {
      this.stderrTail = (this.stderrTail + data.toString('utf8')).slice(-8000);
      this.events.debug(data.toString('utf8'));
    });
    child.on('error', error => this.fail(Error('Could not start FlashTeX host at ' + executable + ': ' + error.message)));
    child.once('close', (code, signal) => {
      if (!this.stopping) {this.fail(Error('FlashTeX host exited (' + (signal || code) + ').'));}
    });
    const until = Date.now() + 120000;
    while (!this.stopping && Date.now() < until) {
      const socket = createConnection(sock);
      const connected = await new Promise<boolean>(resolve => {
        socket.once('error', () => resolve(false));
        socket.once('connect', () => resolve(true));
      });
      if (this.stopping) { socket.destroy(); return; }
      if (connected) {
        this.socket = socket;
        void this.receive(socket).catch(error => this.fail(error));
        this.write(1, { protocol: 'display-list-v3', version: [3, 2] });
        return;
      }
      socket.destroy();
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!this.stopping) {throw Error('Timed out connecting to FlashTeX.');}
  }

  private copyPath(file: string): string { return path.join(this.mirror, path.relative(this.project, file)); }

  isProjectFile(file: string): boolean {
    return inside(this.project, file) && !path.relative(this.project, file).split(path.sep).some(part => excluded.has(part));
  }

  private async copyTree(file: string, directory = false): Promise<void> {
    if (this.stopping || !this.isProjectFile(file)) {return;}
    const dest = this.copyPath(file);
    const entry = await fs.lstat(file).catch(error => {
      if (error.code !== 'ENOENT') {throw error;}
      return undefined;
    });
    // Copy symlinked files as independent files. Never follow a directory
    // symlink, which could walk outside the project or recurse indefinitely.
    if (entry?.isDirectory() && directory) {
      await fs.mkdir(dest, { recursive: true });
      for (const name of await fs.readdir(file)) {await this.copyTree(path.join(file, name), true);}
    } else if (entry?.isFile() || (entry?.isSymbolicLink() && (await fs.stat(file).catch(() => undefined))?.isFile())) {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(file, dest, constants.COPYFILE_FICLONE);
    } else if (!entry) {
      await fs.rm(dest, { force: true, recursive: true });
    }
  }

  send(command: Command): void {
    if (this.stopping) {return;}
    switch (command[0]) {
      case 'open':
        this.updateBuffer(command[1], Buffer.from(command[2], 'utf8'));
        break;
      case 'change': {
        const old = this.buffers.get(command[1]);
        if (old) {this.updateBuffer(command[1], Buffer.concat([old.subarray(0, command[2]),
          Buffer.from(command[4], 'utf8'), old.subarray(command[2] + command[3])]));}
        break;
      }
      case 'close':
        this.updateBuffer(command[1], undefined);
        break;
      case 'pause': this.paused = true; clearTimeout(this.timer); break;
      case 'resume': this.paused = false; this.schedule(); break;
      case 'rescan':
        for (const file of this.announced) {if (!this.buffers.has(file)) {this.diskChanges.add(file);}}
        this.schedule();
        break;
      case 'rerun-once': this.schedule(); break;
      case 'preview-barrier': this.requestedSequence = command[1]; this.schedule(); break;
      case 'preview-render':
      case 'preview-svg':
      case 'preview-auto':
      case 'preview-png': {
        const [, id, page, width, revision, sequence] = command;
        if (revision !== this.revision || sequence !== this.sequence) {
          queueMicrotask(() => this.events.message(['preview-retry', id]));
          break;
        }
        const render = this.render(id, page, width, revision, sequence).catch(error => {
          if (!this.stopping) {this.events.message(['preview-error', id, String(error)]);}
        });
        this.renderers.add(render);
        void render.finally(() => this.renderers.delete(render));
        break;
      }
      case 'preview-destination': {
        const [, revision, sequence, name] = command;
        if (revision !== this.revision || sequence !== this.sequence) {break;}
        const page = [...this.points.pages.values()].find(data => data.annotations.destinations.some(dest => dest.name === name));
        this.events.message(['preview-destination', revision, sequence, name, page?.number ?? -1]);
        break;
      }
      case 'synctex-forward':
        this.forward = [command[1], command[2]];
        this.syncForward();
        break;
      case 'preview-inverse':
        if (!this.inFlight && command[1] === this.revision && command[2] === this.sequence) {
          const hit = this.points.inverse(command[3], command[4], command[5]);
          const file = hit && this.originalPath(hit.file);
          if (hit && file) {
            const bytes = this.buffers.get(file);
            const row = bytes?.toString('utf8').split('\n')[hit.line - 1];
            const column = hit.column === 65535 || row === undefined ? undefined :
              Buffer.from(row, 'utf8').subarray(0, hit.column).toString('utf8').length + 1;
            this.events.debug('[FlashTeX inverse] ' + JSON.stringify({ file, line: hit.line, page: hit.page + 1 }));
            this.events.message(['synctex', file, hit.line, column]);
          }
        }
        break;
    }
  }

  private updateBuffer(file: string, value: Buffer | undefined): void {
    if (!this.isProjectFile(file)) {return;}
    const current = this.buffers.get(file);
    if ((current && value?.equals(current)) || (!current && !value)) {return;}
    if (value) {this.buffers.set(file, value);}
    else {this.buffers.delete(file);}
    this.bufferChanges.add(file);
    this.schedule();
  }

  private schedule(delay = 55): void {
    this.pending = true;
    clearTimeout(this.timer);
    if (this.stopping || this.paused || !this.ready || this.inFlight) {return;}
    this.timer = setTimeout(() => {
      this.compiling = this.compile().catch(error => this.fail(error));
    }, delay);
  }

  private async compile(): Promise<void> {
    if (this.stopping || this.paused || this.inFlight) {return;}
    this.inFlight = true;
    this.pending = false;
    this.sequence = this.requestedSequence;
    const changes = [...this.bufferChanges].map(file => [file, this.buffers.get(file)] as const);
    const disk = [...this.diskChanges].filter(file => !this.buffers.has(file));
    this.bufferChanges.clear();
    this.diskChanges.clear();
    for (const file of disk) {await this.copyTree(file);}
    const buffers = [];
    for (const [file, contents] of changes) {
      if (!contents) {await this.copyTree(file);}
      else if (inside(this.mainDirectory, file)) {
        buffers.push({ path: path.relative(this.mainDirectory, file).split(path.sep).join('/'), text: contents.toString('utf8') });
      } else {
        const dest = this.copyPath(file);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, contents);
      }
    }
    if (this.stopping) {return;}
    this.diagnostics = [];
    this.write(2, {
      id: ++this.id, root: this.root, main: path.basename(this.main), format: 'pdflatex',
      output_dir: this.output, shell_escape: 'off', external_tools: 'off', incremental: true, buffers
    });
  }

  private write(kind: number, value: object): void {
    if (!this.socket?.writable) {return;}
    const body = Buffer.from(JSON.stringify(value));
    const header = Buffer.allocUnsafe(5);
    header.writeUInt32LE(body.length + 1);
    header[4] = kind;
    this.socket.write(Buffer.concat([header, body]));
  }

  private originalPath(file: string): string | undefined {
    // getcwd / realpath on macOS expands /tmp to /private/tmp.
    const absolute = this.normalName(path.resolve(this.root, file));
    return inside(this.mirror, absolute) ? path.join(this.project, path.relative(this.mirror, absolute)) : undefined;
  }

  private normalName(file: string): string {
    return process.platform === 'darwin' ? file.replace(/^\/private\/tmp\//, '/tmp/') : file;
  }

  private async receive(socket: Socket): Promise<void> {
    let pending = Buffer.alloc(0);
    for await (const chunk of socket as AsyncIterable<Buffer>) {
      if (this.stopping) {return;}
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 5 && !this.stopping) {
        const length = pending.readUInt32LE(0);
        if (length < 1 || length > 1 << 28) {throw Error('Invalid FlashTeX frame length.');}
        if (pending.length < length + 4) {break;}
        const kind = pending[4], body = pending.subarray(5, length + 4);
        pending = pending.subarray(length + 4);
        if (kind === 0x45) {this.points.page(decodePage(body));}
        else if (kind === 0x41 || kind === 0x42 || kind === 0x47 || kind === 0x48 || kind === 0x49 || kind === 0x4a) {
          const value = JSON.parse(body.toString('utf8'));
          if (kind === 0x41) {
            if (value.protocol !== 'display-list-v3' || value.version?.[0] !== 3 ||
                !value.capabilities?.includes('incremental')) {throw Error('Incompatible FlashTeX host.');}
            this.ready = true;
            this.schedule(0);
          } else if (kind === 0x42) {
            this.pid = value.pid;
            if (!value.keep) {this.points.clear();}
          } else if (kind === 0x47) {
            const sources = (value.files || []).map(([id, file]: [number, string]) =>
              [id, this.normalName(path.resolve(this.root, file))]);
            for (const name of this.points.sources({ files: sources, spans: value.spans })) {
              const file = this.originalPath(name);
              if (file && !this.announced.has(file)) {
                this.announced.add(file);
                this.events.message(['input-file', this.announced.size, file]);
              }
            }
          } else if (kind === 0x48) {
            if (this.diagnostics.length < 100) {this.diagnostics.push(
              [value.file && (this.originalPath(value.file) || value.file), value.line, value.message].filter(Boolean).join(': '));}
          } else if (kind === 0x49) {await this.done(value);}
          else {throw Error('FlashTeX: ' + (value.message || JSON.stringify(value)));}
        }
      }
    }
    if (!this.stopping) {throw Error('FlashTeX closed the preview connection.');}
  }

  private async done(value: Done): Promise<void> {
    const { id, status, mode, keep, pages, restart_page, converged_at, typeset_pages, elapsed_ms } = value;
    this.events.debug('[FlashTeX compile] ' + JSON.stringify({
      id, pid: this.pid, sequence: this.sequence, status, mode, keep, pages, restart_page, converged_at, typeset_pages, elapsed_ms
    }));
    this.points.finish(pages);
    if (value.pdf && pages > 0) {
      const staged = path.join(this.directory!, 'next.pdf');
      await fs.copyFile(value.pdf, staged, constants.COPYFILE_FICLONE);
      this.published = path.join(this.directory!, 'preview.pdf');
      await fs.rename(staged, this.published);
    }
    if (this.stopping) {return;}
    this.pageCount = value.pdf ? pages : 0;
    this.revision++;
    this.inFlight = false;
    this.events.message(['truncate-lines', 'out', 0]);
    this.events.message(['append-lines', 'out', ...this.diagnostics]);
    if (status !== 'ok' && !this.diagnostics.length) {this.events.message(['append-lines', 'out', 'FlashTeX compilation: ' + status]);}
    this.events.message(['flush']);
    if (this.sequence === this.requestedSequence) {
      this.events.message(['preview-state', this.revision, this.sequence, this.pageCount, true, 0]);
      this.syncForward();
    }
    if (this.pending) {this.schedule();}
  }

  private syncForward(): void {
    if (!this.forward || this.inFlight || this.sequence !== this.requestedSequence) {return;}
    const [file, line] = this.forward;
    this.forward = undefined;
    const hit = this.points.forward(this.normalName(this.copyPath(file)), line);
    if (hit) {
      this.events.debug('[FlashTeX forward] ' + JSON.stringify({ file, line: hit.line, page: hit.page + 1 }));
      this.events.message(['preview-forward', this.revision, this.sequence, hit.page, hit.x, hit.y]);
    }
  }

  private async render(id: number, page: number, width: number, revision: number, sequence: number): Promise<void> {
    const pdf = this.published;
    if (!pdf || page >= this.pageCount) {
      this.events.message(['preview-error', id, 'FlashTeX has no PDF page to display. See TeXpresso output for compiler diagnostics.']);
      return;
    }
    const tool = this.config.flashtexMutool || 'mutool';
    const extract = (kind: string, extra: string[]) => exec(tool,
      ['draw', '-q', '-b', 'MediaBox', '-F', kind, '-o', '-', ...extra, pdf, String(page + 1)],
      { encoding: 'buffer', maxBuffer: MAX_IMAGE_BYTES, timeout: 15000, signal: this.abort.signal });
    const [png, text] = await Promise.all([
      extract('png', ['-w', String(Math.min(width, 1950)), '-h', '1950']),
      extract('stext', [])
    ]);
    if (this.stopping) {return;}
    if (sequence !== this.requestedSequence || revision !== this.revision) {
      this.events.message(['preview-retry', id]);
      return;
    }
    const bytes = png.stdout;
    const header = {
      requestId: id, revision, sequence, page, mime: 'image/png' as const, byteLength: bytes.length,
      width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20),
      annotations: this.points.pages.get(page)?.annotations, ...decodeText(text.stdout.toString('utf8'))
    };
    if (!isImageHeader(header)) {throw Error('Invalid FlashTeX preview image.');}
    this.events.image?.({ header, bytes });
  }

  private fail(error: Error): void {
    if (!this.stopping) {this.events.error(error);}
  }

  dispose(): Promise<void> {
    if (this.shutdown) {return this.shutdown;}
    this.stopping = true;
    clearTimeout(this.timer);
    this.watcher?.dispose();
    this.abort.abort();
    this.socket?.destroy();
    this.shutdown = (async () => {
      await this.launch?.catch(() => {});
      if (this.child) {await terminate(this.child);}
      await this.compiling;
      await Promise.all(this.renderers);
      if (this.directory) {await fs.rm(this.directory, { recursive: true, force: true });}
    })().catch(error => this.events.debug(String(error)));
    return this.shutdown;
  }
}
