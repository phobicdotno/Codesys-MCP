import { describe, it, expect } from 'vitest';
import { findReservedIecIdentifiers } from '../../src/server';

// Guard against IEC 61131-3 reserved words used as variable names in
// declarationCode. Found the hard way: `by : BYTE;` (FOR..BY keyword)
// compiles a red error in CODESYS but used to sail straight through the
// MCP into the binary project.

describe('findReservedIecIdentifiers', () => {
  it('flags the FOR..BY keyword regardless of case', () => {
    for (const name of ['by', 'By', 'BY']) {
      const warnings = findReservedIecIdentifiers(`VAR\n    ${name} : BYTE;\nEND_VAR`);
      expect(warnings, name).toHaveLength(1);
      expect(warnings[0]).toContain('reserved keyword');
    }
  });

  it('flags control-flow, type, operator, and OOP keywords', () => {
    for (const name of ['if', 'to', 'of', 'do', 'and', 'or', 'not', 'mod',
                        'array', 'pointer', 'string', 'time', 'true', 'this',
                        'super', 'at', 'retain', 'type', 'exit', 'return']) {
      const warnings = findReservedIecIdentifiers(`VAR\n    ${name} : INT;\nEND_VAR`);
      expect(warnings, name).toHaveLength(1);
    }
  });

  it('keeps the original case-sensitive time-suffix identifiers', () => {
    expect(findReservedIecIdentifiers('VAR\n    ms : INT;\nEND_VAR')).toHaveLength(1);
    expect(findReservedIecIdentifiers('VAR\n    S : BOOL;\nEND_VAR')).toHaveLength(1);
    // 'Ms' is not in the case-sensitive suffix set and is not a keyword
    expect(findReservedIecIdentifiers('VAR\n    Ms : INT;\nEND_VAR')).toHaveLength(0);
  });

  it('checks every name in a comma-separated declaration list', () => {
    const warnings = findReservedIecIdentifiers('VAR\n    ok1, by, ok2 : BYTE;\nEND_VAR');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("'by'");
  });

  it('does not flag ordinary names, type usages, or member access', () => {
    expect(findReservedIecIdentifiers([
      'FUNCTION_BLOCK FB_Test',
      'VAR_INPUT',
      '    ByteCount : UDINT;      // contains "by" as prefix - fine',
      '    Config    : ST_Config;',
      '    Values    : ARRAY[0..7] OF INT;',
      'END_VAR',
    ].join('\n'))).toHaveLength(0);
  });

  it('flags CODESYS compiler operator names in any casing (sIn/SIN gap, 2026-09-07)', () => {
    for (const name of ['sIn', 'SIN', 'sin', 'diV', 'DIV', 'min', 'Max', 'abs', 'sel', 'Limit', 'trunc', 'shl']) {
      const warnings = findReservedIecIdentifiers(`VAR
    ${name} : INT;
END_VAR`);
      expect(warnings, name).toHaveLength(1);
      expect(warnings[0]).toContain('operator');
    }
  });

  it('does not flag library-function names (LEN/MID shadow, not compiler tokens)', () => {
    expect(findReservedIecIdentifiers(`VAR
    len : INT;
    mid : INT;
END_VAR`)).toHaveLength(0);
    // names merely containing an operator are fine
    expect(findReservedIecIdentifiers(`VAR
    sInput : STRING;
    diValue : DINT;
END_VAR`)).toHaveLength(0);
  });

  it('handles AT %address declarations', () => {
    expect(findReservedIecIdentifiers('VAR\n    by AT %QB0 : BYTE;\nEND_VAR')).toHaveLength(1);
    expect(findReservedIecIdentifiers('VAR\n    xOut AT %QX0.0 : BOOL;\nEND_VAR')).toHaveLength(0);
  });

  it('returns empty for empty/undefined input', () => {
    expect(findReservedIecIdentifiers(undefined)).toHaveLength(0);
    expect(findReservedIecIdentifiers('')).toHaveLength(0);
  });
});
