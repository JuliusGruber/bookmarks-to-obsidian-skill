import { describe, it, expect } from 'vitest';
import { GATEWAY_IMAGE, dockerRunArgs } from '../src/bootstrap/docker.mjs';

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
