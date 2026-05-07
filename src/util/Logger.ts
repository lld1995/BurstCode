import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {
  private readonly channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel('BurstCode');
  }

  info(msg: string, ...args: unknown[]): void {
    this.write('INFO', msg, args);
  }

  warn(msg: string, ...args: unknown[]): void {
    this.write('WARN', msg, args);
  }

  error(msg: string, ...args: unknown[]): void {
    this.write('ERROR', msg, args);
  }

  debug(msg: string, ...args: unknown[]): void {
    this.write('DEBUG', msg, args);
  }

  private write(level: string, msg: string, args: unknown[]): void {
    const ts = new Date().toISOString();
    const extra = args.length
      ? ' ' + args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
      : '';
    this.channel.appendLine(`[${ts}] [${level}] ${msg}${extra}`);
  }

  show(): void {
    this.channel.show();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
