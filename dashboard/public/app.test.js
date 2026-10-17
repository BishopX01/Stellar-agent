// dashboard/public/app.test.js
// Unit tests for the pre-flight transaction simulation helpers.
// Run with: npm test (see package.json "test" script)

const {
  parseSimulationResult,
  extractSimulationError,
} = require('./app.js');

describe('parseSimulationResult', () => {
  test('extracts cpuInsns, memBytes, minResourceFee and balance diffs from a successful simulation', () => {
    const sample = {
      // Mirrors the shape returned by rpc.Server.simulateTransaction()
      transactionData: {
        buildSuccess: true,
        resources: {
          instructions: 1234567,
          readBytes: 2048,
          writeBytes: 512,
        },
        footprint: {
          readOnly: ['AAAA'],
          readWrite: ['BBBB'],
        },
      },
      cost: {
        cpuInsns: '1234567',
        memBytes: '4096',
      },
      minResourceFee: '100234',
      result: {
        retval: 'AAAAAA==',
        auth: [],
      },
      // Balance diffs as produced by the simulation (token balance changes)
      balanceDiffs: [
        {
          asset: 'native',
          amount: '-100234',
        },
        {
          asset: 'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          amount: '-5000000',
        },
      ],
      latestLedger: 12345,
      events: [],
    };

    const parsed = parseSimulationResult(sample);

    expect(parsed).not.toBeNull();
    expect(parsed.cpuInsns).toBe(1234567);
    expect(parsed.memBytes).toBe(4096);
    expect(parsed.minResourceFee).toBe(100234);

    expect(Array.isArray(parsed.balanceDiffs)).toBe(true);
    expect(parsed.balanceDiffs).toHaveLength(2);
    expect(parsed.balanceDiffs[0]).toEqual({
      asset: 'native',
      amount: -100234,
    });
    expect(parsed.balanceDiffs[1].asset).toBe(
      'USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
    );
    expect(parsed.balanceDiffs[1].amount).toBe(-5000000);
  });

  test('falls back to transactionData.resources when cost block is absent', () => {
    const sample = {
      transactionData: {
        buildSuccess: true,
        resources: {
          instructions: 999,
          readBytes: 100,
          writeBytes: 200,
        },
      },
      minResourceFee: '42',
      result: { retval: 'AAAAAA==', auth: [] },
      balanceDiffs: [],
    };

    const parsed = parseSimulationResult(sample);

    expect(parsed).not.toBeNull();
    expect(parsed.cpuInsns).toBe(999);
    // memBytes derived from readBytes + writeBytes
    expect(parsed.memBytes).toBe(300);
    expect(parsed.minResourceFee).toBe(42);
    expect(parsed.balanceDiffs).toEqual([]);
  });

  test('returns null for a null/undefined simulation result', () => {
    expect(parseSimulationResult(null)).toBeNull();
    expect(parseSimulationResult(undefined)).toBeNull();
  });

  test('returns null when the simulation indicates failure', () => {
    const failed = {
      error: 'HostError: Error(Contract, #1)',
      transactionData: { buildSuccess: false },
    };
    expect(parseSimulationResult(failed)).toBeNull();
  });
});

describe('extractSimulationError', () => {
  test('returns null for a successful simulation', () => {
    const success = {
      transactionData: { buildSuccess: true },
      cost: { cpuInsns: '10', memBytes: '20' },
      minResourceFee: '5',
      result: { retval: 'AAAAAA==', auth: [] },
    };
    expect(extractSimulationError(success)).toBeNull();
  });

  test('returns null for a null/undefined simulation result', () => {
    expect(extractSimulationError(null)).toBeNull();
    expect(extractSimulationError(undefined)).toBeNull();
  });

  test('extracts contract error code and message for insufficient token balance', () => {
    const failed = {
      error: 'HostError: Error(Contract, #1)',
      transactionData: { buildSuccess: false },
      // Soroban contract error details
      diagnosticEvents: [
        {
          type: 'diagnostic',
          contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
          topics: ['error'],
          data: 'insufficient balance',
        },
      ],
    };

    const err = extractSimulationError(failed);

    expect(err).not.toBeNull();
    expect(err.code).toBe(1);
    expect(typeof err.message).toBe('string');
    expect(err.message.toLowerCase()).toContain('insufficient');
    expect(err.raw).toBe('HostError: Error(Contract, #1)');
  });

  test('extracts contract error code from a plain error string', () => {
    const failed = {
      error: 'HostError: Error(Contract, #7)',
      transactionData: { buildSuccess: false },
    };

    const err = extractSimulationError(failed);

    expect(err).not.toBeNull();
    expect(err.code).toBe(7);
    expect(err.raw).toBe('HostError: Error(Contract, #7)');
  });

  test('returns a generic error object when no contract code is present', () => {
    const failed = {
      error: 'network timeout',
      transactionData: { buildSuccess: false },
    };

    const err = extractSimulationError(failed);

    expect(err).not.toBeNull();
    expect(err.code).toBeNull();
    expect(err.message).toBe('network timeout');
    expect(err.raw).toBe('network timeout');
  });
});