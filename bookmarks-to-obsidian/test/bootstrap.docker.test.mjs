import { describe, it, expect } from 'vitest';
import { GATEWAY_IMAGE, dockerRunArgs, parseHostIp } from '../src/bootstrap/docker.mjs';

describe('GATEWAY_IMAGE', () => {
  it('is the pinned 0.3.0 image', () => {
    expect(GATEWAY_IMAGE).toBe('pvoronin/chrome-bookmarks-gateway:0.3.0');
  });
});

describe('dockerRunArgs', () => {
  const args = dockerRunArgs();

  it('runs detached and names the container cbg', () => {
    expect(args.slice(0, 2)).toEqual(['run', '-d']);
    const nameIdx = args.indexOf('--name');
    expect(args[nameIdx + 1]).toBe('cbg');
  });

  it('publishes port 3000', () => {
    const pIdx = args.indexOf('-p');
    expect(args[pIdx + 1]).toBe('3000:3000');
  });

  it('adds the host-gateway alias so host.docker.internal resolves on native Linux', () => {
    expect(args).toContain('--add-host=host.docker.internal:host-gateway');
  });

  it('disables auth and points CDP at host.docker.internal:9223 by default', () => {
    expect(args).toContain('AUTH_TOKEN=off');
    expect(args).toContain('CHROME_CDP_URL=http://host.docker.internal:9223');
  });

  it('puts the pinned image last', () => {
    expect(args[args.length - 1]).toBe(GATEWAY_IMAGE);
  });

  it('honors a custom hostCdpUrl', () => {
    const a = dockerRunArgs({ hostCdpUrl: 'http://host.docker.internal:9999' });
    expect(a).toContain('CHROME_CDP_URL=http://host.docker.internal:9999');
  });
});

describe('parseHostIp', () => {
  const ETC_HOSTS = [
    '127.0.0.1\tlocalhost',
    '::1\tlocalhost ip6-localhost ip6-loopback',
    'ff02::2\tip6-allrouters',
    '192.168.65.254\thost.docker.internal',
    '172.17.0.4\tb26df65c32d8',
  ].join('\n');

  it('extracts the IP mapped to host.docker.internal (Docker Desktop)', () => {
    expect(parseHostIp(ETC_HOSTS)).toBe('192.168.65.254');
  });

  it('works with a native-Linux host-gateway IP', () => {
    expect(parseHostIp('172.17.0.1  host.docker.internal\n')).toBe('172.17.0.1');
  });

  it('matches when host.docker.internal is one of several aliases on a line', () => {
    expect(parseHostIp('10.0.0.5 gateway host.docker.internal other\n')).toBe('10.0.0.5');
  });

  it('ignores commented lines', () => {
    expect(parseHostIp('# 9.9.9.9 host.docker.internal\n8.8.8.8 host.docker.internal\n')).toBe('8.8.8.8');
  });

  it('returns null when the hostname is absent', () => {
    expect(parseHostIp('127.0.0.1 localhost\n')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(parseHostIp('')).toBeNull();
  });
});
