import { describe, it, expect } from 'vitest';
import { handleVerifyNodeConnections } from '../../../src/tools/node-tools.js';
import { createFakeRunner } from '../../helpers/fake-runner.js';
import { hasError, unwrap } from '../../helpers/assertions.js';
import { fixtureProjectPath, fixtureScenePath } from '../../helpers/fixture-paths.js';

const validBase = { projectPath: fixtureProjectPath, scenePath: fixtureScenePath };

function parseResult(result: unknown): {
  verified: boolean;
  issueCount: number;
  issues: unknown[];
} {
  const envelope = unwrap(result);
  return JSON.parse(envelope.content[0]!.text);
}

describe('handleVerifyNodeConnections', () => {
  it('rejects missing projectPath', async () => {
    const fake = createFakeRunner();
    const result = await handleVerifyNodeConnections(fake.asRunner, {
      scenePath: fixtureScenePath,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects projectPath containing ..', async () => {
    const fake = createFakeRunner();
    const result = await handleVerifyNodeConnections(fake.asRunner, {
      projectPath: '../evil',
      scenePath: fixtureScenePath,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects nonexistent project', async () => {
    const fake = createFakeRunner();
    const result = await handleVerifyNodeConnections(fake.asRunner, {
      projectPath: '/ghost',
      scenePath: fixtureScenePath,
    });
    expect(hasError(result)).toBe(true);
  });

  it('rejects missing scenePath', async () => {
    const fake = createFakeRunner();
    const result = await handleVerifyNodeConnections(fake.asRunner, {
      projectPath: fixtureProjectPath,
    });
    expect(hasError(result)).toBe(true);
  });

  it('passes valid nodePath', async () => {
    const fake = createFakeRunner({ stdout: '{"verified":true,"issueCount":0,"issues":[]}' });
    const result = await handleVerifyNodeConnections(fake.asRunner, {
      ...validBase,
      nodePath: 'root/GameArea',
    });
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.verified).toBe(true);
    expect(data.issueCount).toBe(0);
    expect(Array.isArray(data.issues)).toBe(true);
  });

  it('allows missing nodePath (scan entire scene)', async () => {
    const fake = createFakeRunner({ stdout: '{"verified":true,"issueCount":0,"issues":[]}' });
    const result = await handleVerifyNodeConnections(fake.asRunner, validBase);
    expect(hasError(result)).toBe(false);
  });

  it('parses verified:true response', async () => {
    const stdout = JSON.stringify({ verified: true, issueCount: 0, issues: [] });
    const fake = createFakeRunner({ stdout });
    const result = await handleVerifyNodeConnections(fake.asRunner, validBase);
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.verified).toBe(true);
    expect(data.issueCount).toBe(0);
    expect(data.issues).toEqual([]);
  });

  it('parses verified:false with issues', async () => {
    const issues = [
      {
        node: 'root/Button',
        signal: 'pressed',
        target: 'root/Label',
        method: '_on_button_pressed',
        problem: 'method_missing_on_target',
      },
      {
        node: 'root/Area2D',
        signal: 'body_entered',
        target: 'root/Player',
        method: 'handle_body_entered',
        problem: 'naming_convention',
      },
      {
        node: 'root/Player',
        signal: '',
        target: 'root/Player',
        method: '_on_orphaned_handler',
        problem: 'orphaned_handler',
      },
    ];
    const stdout = JSON.stringify({ verified: false, issueCount: 3, issues });
    const fake = createFakeRunner({ stdout });
    const result = await handleVerifyNodeConnections(fake.asRunner, validBase);
    expect(hasError(result)).toBe(false);
    const data = parseResult(result);
    expect(data.verified).toBe(false);
    expect(data.issueCount).toBe(3);
    expect(data.issues).toEqual(issues);
  });

  it('forwards nodePath to GDScript operation', async () => {
    const fake = createFakeRunner({ stdout: '{"verified":true,"issueCount":0,"issues":[]}' });
    await handleVerifyNodeConnections(fake.asRunner, {
      ...validBase,
      nodePath: 'root/SubViewport',
    });
    expect(fake.calls.length).toBe(1);
    expect(fake.calls[0]!.operation).toBe('verify_node_connections');
    expect(fake.calls[0]!.params.nodePath).toBe('root/SubViewport');
  });

  it('omits nodePath when not provided', async () => {
    const fake = createFakeRunner({ stdout: '{"verified":true,"issueCount":0,"issues":[]}' });
    await handleVerifyNodeConnections(fake.asRunner, validBase);
    expect(fake.calls[0]!.params).not.toHaveProperty('nodePath');
  });
});
