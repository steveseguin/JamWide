import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Exercise the real entry point, WebSocket dispatch, and UI together. No network,
// camera, microphone, or real popout is opened.
class PluginSocket {
  static OPEN = 1;
  static instances: PluginSocket[] = [];
  readyState = PluginSocket.OPEN;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(_url: string) {
    PluginSocket.instances.push(this);
  }

  sendMessage(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

let socket: PluginSocket;
const config = { type: 'config', room: 'test-room', push: 'publisher', noaudio: true, wsPort: 7170 };
const roster = { type: 'roster', users: [{ idx: 0, name: 'Alice', streamId: 'alice' }] };

function changeSetting(id: string, value: string): void {
  const select = document.getElementById(id) as HTMLSelectElement;
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

describe('explicit video deactivation', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    PluginSocket.instances = [];
    vi.stubGlobal('WebSocket', PluginSocket);
    localStorage.clear();
    document.body.innerHTML = `
      <span id="status-badge"></span><span id="session-info"></span>
      <select id="bg-effect"><option>none</option><option>blur</option></select>
      <select id="bandwidth-profile"><option>balanced</option><option>high</option></select>
      <main id="main-area"></main>
      <span id="ws-dot"></span><span id="ws-status-text"></span>
      <button id="reconnect-btn"></button>
      <span id="sync-indicator"><span id="sync-beat-dot"></span><span id="sync-beat-label"></span></span>
      <input id="delay-slider" type="range" min="0" max="30000">
      <button id="delay-auto-btn"></button><span id="delay-status"></span>`;
    vi.spyOn(window, 'open').mockReturnValue(null);
    await import('../main');
    socket = PluginSocket.instances[0];
    socket.onopen?.();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    document.body.textContent = '';
  });

  it('removes the publishing iframe as soon as deactivate arrives, before socket close', () => {
    socket.sendMessage(config);
    const iframe = document.querySelector('iframe')!;
    expect(new URL(iframe.src).searchParams.get('push')).toBe('publisher');

    socket.sendMessage({ type: 'deactivate' });

    expect(iframe.isConnected).toBe(false);
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.getElementById('main-area')!.textContent).toContain('Video deactivated');
    expect(document.getElementById('status-badge')!.textContent).toBe('Disconnected');
    expect(document.getElementById('ws-status-text')!.textContent).toContain('Video deactivated');
    expect(document.getElementById('reconnect-btn')!.style.display).toBe('none');
    expect(document.getElementById('sync-indicator')!.style.display).toBe('none');
  });

  it('preserves the same publishing iframe on an ordinary socket disconnect', () => {
    socket.sendMessage(config);
    const iframe = document.querySelector('iframe');
    socket.close();
    expect(document.querySelector('iframe')).toBe(iframe);
    expect(document.getElementById('reconnect-btn')!.style.display).toBe('inline-block');
  });

  it('cannot recreate the publisher through either settings dropdown after deactivate', () => {
    socket.sendMessage(config);
    socket.sendMessage({ type: 'deactivate' });
    socket.close();

    changeSetting('bg-effect', 'blur');
    changeSetting('bandwidth-profile', 'high');

    expect(document.querySelector('iframe')).toBeNull();
    expect(localStorage.getItem('jamwide-bg-effect')).toBe('blur');
    expect(localStorage.getItem('jamwide-bandwidth-profile')).toBe('high');
    expect(document.getElementById('reconnect-btn')!.style.display).toBe('none');
  });

  it('closes popouts and removes stale roster controls on deactivate', () => {
    const close = vi.fn();
    const popout = { closed: false, focus: vi.fn(), close, postMessage: vi.fn() };
    vi.mocked(window.open).mockReturnValue(popout as unknown as Window);
    socket.sendMessage(config);
    socket.sendMessage(roster);
    const pill = document.querySelector('.roster-pill') as HTMLButtonElement;
    pill.click();
    expect(window.open).toHaveBeenCalledTimes(1);

    socket.sendMessage({ type: 'deactivate' });
    socket.sendMessage(roster);
    socket.sendMessage({ type: 'popout', streamId: 'alice' });
    pill.click(); // A detached control must not reopen the previous session either.

    expect(close).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.roster-pill')).toBeNull();
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it('handles deactivation before initial config and repeated deactivation without loading video', () => {
    socket.sendMessage({ type: 'deactivate' });
    socket.sendMessage({ type: 'deactivate' });
    socket.close();
    changeSetting('bg-effect', 'blur');
    expect(document.querySelector('iframe')).toBeNull();
    expect(document.getElementById('main-area')!.textContent).toContain('Video deactivated');
  });

  it('does not revive a removed iframe through pending load retries', () => {
    socket.sendMessage({ type: 'bufferDelay', delayMs: 8000 });
    socket.sendMessage(config);
    const iframe = document.querySelector('iframe')!;
    iframe.dispatchEvent(new Event('load'));
    socket.sendMessage({ type: 'deactivate' });
    vi.advanceTimersByTime(4000);
    expect(iframe.isConnected).toBe(false);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('accepts a new config after reconnect and uses the newly supplied session', () => {
    socket.sendMessage(config);
    socket.sendMessage({ type: 'deactivate' });
    socket.close();
    document.getElementById('reconnect-btn')!.click();
    const replacement = PluginSocket.instances[PluginSocket.instances.length - 1];
    replacement.onopen?.();
    replacement.sendMessage({ ...config, room: 'new-room', push: 'new-publisher' });
    changeSetting('bandwidth-profile', 'high');
    const url = new URL(document.querySelector('iframe')!.src);
    expect(url.searchParams.get('room')).toBe('new-room');
    expect(url.searchParams.get('push')).toBe('new-publisher');
    expect(url.searchParams.get('quality')).toBe('0');
    expect(document.getElementById('status-badge')!.textContent).toBe('Connected');
    expect(document.getElementById('ws-status-text')!.textContent).toBe('Connected to plugin');
  });
});
