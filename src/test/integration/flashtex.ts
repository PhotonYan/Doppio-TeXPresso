import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';

async function logs(directory = process.env.TEXPRESSO_TEST_LOGS!): Promise<string> {
  const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  return (await Promise.all(files.map(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? logs(file) : /Doppio TeXPresso.*\.log$/.test(entry.name) ? fs.readFile(file, 'utf8') : '';
  }))).join('\n');
}

async function until<T>(fn: () => Promise<T | undefined>, description: string): Promise<T> {
  const end = Date.now() + 35000;
  while (Date.now() < end) {
    const value = await fn();
    if (value) {return value;}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error(description + '\n' + (await logs()).slice(-8000));
}

async function pageEval<T>(expression: string): Promise<T | undefined> {
  const base = 'http://127.0.0.1:' + process.env.TEXPRESSO_DEBUG_PORT;
  const targets = await (await fetch(base + '/json/list')).json() as
    { type: string; url: string; webSocketDebuggerUrl: string }[];
  const { WebSocket } = globalThis as unknown as {
    WebSocket: new (url: string) => {
      addEventListener(type: string, callback: (event: { data: string }) => void, options?: { once: boolean }): void;
      removeEventListener(type: string, callback: (event: { data: string }) => void): void;
      send(message: string): void;
      close(): void;
    };
  };
  for (const target of targets.filter(t => t.type === 'iframe' && t.url.includes('doppio-texpresso'))) {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(Error('Could not connect to VS Code debugger')), { once: true });
      });
      let next = 0;
      const call = <R>(method: string, params = {}) => new Promise<R>((resolve, reject) => {
        const id = ++next;
        const receive = (event: { data: string }) => {
          const reply = JSON.parse(event.data);
          if (reply.id !== id) {return;}
          clearTimeout(timer);
          socket.removeEventListener('message', receive);
          if (reply.error) {reject(Error(reply.error.message));}
          else {resolve(reply.result);}
        };
        const timer = setTimeout(() => {
          socket.removeEventListener('message', receive);
          reject(Error('VS Code debugger timed out: ' + method));
        }, 5000);
        socket.addEventListener('message', receive);
        socket.send(JSON.stringify({ id, method, params }));
      });
      const contexts: number[] = [];
      socket.addEventListener('message', event => {
        const data = JSON.parse(event.data);
        if (data.method === 'Runtime.executionContextCreated' && data.params.context.auxData?.isDefault) {
          contexts.push(data.params.context.id);
        }
      });
      await call('Runtime.enable');
      for (const contextId of contexts) {
        const { result } = await call<{ result: { value?: T } }>('Runtime.evaluate',
          { expression, contextId, returnByValue: true });
        if (result.value) {return result.value;}
      }
    } finally { socket.close(); }
  }
}

type Compile = { pid: number; id: number; mode: string; status: string; pages: number; restart_page: number; typeset_pages: number; converged_at?: number; elapsed_ms: number };
const compiles = async (): Promise<Compile[]> => [...(await logs()).matchAll(/\[FlashTeX compile\] (\{[^\n]+\})/g)]
  .map(match => JSON.parse(match[1]) as Compile);
const stop = () => vscode.commands.executeCommand('texpresso.stop');

export async function run(): Promise<void> {
  const ext = vscode.extensions.getExtension('PhotonYan.doppio-texpresso');
  const lw = vscode.extensions.getExtension('James-Yu.latex-workshop');
  assert.ok(ext);
  await ext.activate(); await lw?.activate();
  const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
  const file = path.join(root, 'main.tex'), included = path.join(root, 'chapter.tex');
  const source = '% !TeX root = main.tex\n' +
    Array.from({ length: 24 }, (_, i) => 'Page ' + (i + 1) + ' anchor.\n\\newpage').join('\n') + '\n';
  await fs.writeFile(file, '\\documentclass{article}\n\\begin{document}\n\\input{chapter}\n\\end{document}\n');
  await fs.writeFile(included, source);
  const chapter = await vscode.workspace.openTextDocument(included);
  const editor = await vscode.window.showTextDocument(chapter, vscode.ViewColumn.One);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'txp-models-'));
  try {
    const start = vscode.commands.executeCommand('texpresso.openPreview');
    await new Promise(resolve => setTimeout(resolve, 500));
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await start;
    assert.equal(vscode.workspace.getConfiguration('texpresso', chapter.uri).get('engine'), 'pdflatex',
      'The selected compiler is saved for the workspace');
    const cold = await until(async () => (await compiles()).find(result => result.mode === 'cold' && result.status === 'ok'), 'Initial pdfLaTeX compile');
    assert.equal(cold.pages, 24);
    await until(async () => (await logs()).includes('[preview-ui] ["decoded"') || undefined, 'pdfLaTeX page decoded in the VS Code webview');
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)));
    const main = vscode.workspace.textDocuments.find(document => document.fileName === file);
    assert.ok(main);
    assert.ok(!vscode.window.visibleTextEditors.some(editor => editor.document === main));
    // Fill VS Code's bounded background document cache. Its idle timer
    // releases references through the same onDidCloseTextDocument path.
    for (let index = 0; index < 70; index++) {
      const filename = path.join(scratch, index + '.txt');
      await fs.writeFile(filename, 'Background document\n');
      await vscode.workspace.openTextDocument(filename);
    }
    await until(async () => main.isClosed || undefined, 'VS Code releases the hidden root text model');
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)),
      'The PDF preview remains open after the hidden root is released');
    const line = 35;
    assert.ok(await editor.edit(edit => edit.replace(chapter.lineAt(line).range, 'Page 18 updated from VS Code.')));
    assert.ok(chapter.isDirty);
    assert.equal(await fs.readFile(included, 'utf8'), source, 'The real source file was untouched');
    const warm = await until(async () => (await compiles()).find(result =>
      result.id > cold.id && result.mode === 'incremental' && result.status === 'ok' && result.restart_page >= 16), 'FlashTeX restored an earlier checkpoint');
    assert.equal(warm.pid, cold.pid);
    assert.equal(warm.pages, 24);
    assert.ok(warm.typeset_pages < 8);
    const forward = /\[FlashTeX forward\].*"line":36,"page":18/;
    await until(async () => forward.test(await logs()) || undefined, 'edit scrolls to page 18 after compiling');
    editor.selection = new vscode.Selection(line, 0, line, 0);
    await vscode.commands.executeCommand('texpresso.syncTeXForward');
    await until(async () => (await logs()).split('\n').filter(line => forward.test(line)).length >= 2 || undefined, 'manual forward search locates page 18');
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const selected = await until(() => pageEval<string>(`(() => {
      for (const layer of document.querySelectorAll('.page-text')) {
        if (!layer.textContent.includes('Page 18 updated from VS Code.')) continue;
        const range = document.createRange();
        range.selectNodeContents(layer);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        const text = selection.toString();
        selection.removeAllRanges();
        const span = [...layer.children].find(el => el.textContent === 'P');
        const rect = span.getBoundingClientRect();
        if (!rect.width) continue;
        span.dispatchEvent(new MouseEvent('click', { bubbles: true, metaKey: true, ctrlKey: true,
          clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
        return text;
      }
    })()`), 'Updated PDF text rendered, is selectable, and accepts modifier-click');
    assert.match(selected, /Page 18 updated from VS Code\./);
    await until(async () => (await logs()).includes('[FlashTeX inverse]') &&
      vscode.window.activeTextEditor?.document === chapter && vscode.window.activeTextEditor.selection.active.line === line || undefined,
      'Modifier-click opens the correct included file and line');
    assert.equal(await fs.readFile(included, 'utf8'), source);
    console.log('PASS PDF preview survives hidden-root eviction and still compiles unsaved edits in the same process with both sync directions');
    console.log('FlashTeX metrics ' + JSON.stringify({ cold, warm }));
    await vscode.commands.executeCommand('texpresso.openPreview');
    assert.equal((await compiles()).filter(result => result.mode === 'cold').length, 1, 'Open Preview reuses the selected preview');
    await vscode.commands.executeCommand('texpresso.restart');
    await until(async () => (await compiles()).find(result => result.pid !== cold.pid && result.mode === 'cold' && result.status === 'ok'),
      'Restart reopens the disposed main document and keeps the selected compiler');
    assert.equal(vscode.window.activeTextEditor?.document, chapter);
    const changeDefault = vscode.commands.executeCommand('texpresso.selectDefaultCompiler');
    await new Promise(resolve => setTimeout(resolve, 500));
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    await changeDefault;
    assert.equal(vscode.workspace.getConfiguration('texpresso', chapter.uri).get('engine'), 'xelatex');
    await until(async () => /Starting: .*"-headless"/.test(await logs()) || undefined,
      'Changing the default switches the running preview to XeLaTeX');
    console.log('PASS preview chooser saves pdfLaTeX and can switch the workspace default to XeLaTeX');
  } finally {
    await stop();
    await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await fs.rm(scratch, { recursive: true, force: true });
  }
}
