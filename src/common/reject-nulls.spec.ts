import { BadRequestException } from '@nestjs/common';
import { rejectNulls } from './reject-nulls.js';

describe('rejectNulls', () => {
  it('accepts missing fields and values', () => {
    expect(() => rejectNulls({ name: 'a', startDate: '2026-01-01' })).not.toThrow();
    expect(() => rejectNulls({})).not.toThrow();
  });

  it('refuses a null with a 400 that names the field', () => {
    expect(() => rejectNulls({ startDate: null })).toThrow(BadRequestException);
    expect(() => rejectNulls({ startDate: null })).toThrow('startDate must not be null');
  });

  it('lets the allowed fields be cleared', () => {
    expect(() => rejectNulls({ description: null }, ['description'])).not.toThrow();
    expect(() => rejectNulls({ description: null, name: null }, ['description'])).toThrow(/name/);
  });
});
