import { describe, it, expect } from 'vitest';
import { PLAN_TABS, tabForSection, sectionAnchor, resolvePlanTab, tabAfterKey } from './planTabs.ts';

describe('tabForSection', () => {
  it('maps every old section to its tab', () => {
    expect(tabForSection('you')).toBe('people');
    expect(tabForSection('partner')).toBe('people');
    expect(tabForSection('ss')).toBe('people');
    expect(tabForSection('spending')).toBe('spending');
    expect(tabForSection('savings')).toBe('savings');
    expect(tabForSection('home')).toBe('home');
    expect(tabForSection('family')).toBe('home');
    expect(tabForSection('advanced')).toBe('rates');
  });
  it('sends the home growth rates to Rates, where they moved', () => {
    expect(tabForSection('homeRates')).toBe('rates');
  });
  it('accepts a tab name and rejects anything else', () => {
    for (const t of PLAN_TABS) expect(tabForSection(t)).toBe(t);
    expect(tabForSection('nope')).toBeNull();
    expect(tabForSection('toString')).toBeNull();
  });
});

describe('sectionAnchor', () => {
  it('scrolls to the panel top unless the section is partway down its tab', () => {
    expect(sectionAnchor('you')).toBe('fc-inputs');
    expect(sectionAnchor('home')).toBe('fc-inputs');
    expect(sectionAnchor('ss')).toBe('fc-group-ss');
    expect(sectionAnchor('family')).toBe('fc-group-family');
    expect(sectionAnchor('homeRates')).toBe('fc-group-home-rates');
  });
});

describe('resolvePlanTab', () => {
  it('uses a stored tab', () => {
    expect(resolvePlanTab('savings', { you: true })).toBe('savings');
  });
  it('reads an old section id stored as the tab', () => {
    expect(resolvePlanTab('advanced', {})).toBe('rates');
  });
  it('with no stored tab, opens where the old layout had its first open section', () => {
    expect(resolvePlanTab('', { you: true, savings: true })).toBe('people');
    expect(resolvePlanTab('', { you: false, savings: true, advanced: true })).toBe('savings');
    expect(resolvePlanTab('', { family: true })).toBe('home');
    expect(resolvePlanTab(undefined, { advanced: true })).toBe('rates');
  });
  it('falls back to People for missing or malformed state', () => {
    expect(resolvePlanTab('', {})).toBe('people');
    expect(resolvePlanTab(null, null)).toBe('people');
    expect(resolvePlanTab(42, ['you'])).toBe('people');
    expect(resolvePlanTab('bogus', 'bogus')).toBe('people');
    expect(resolvePlanTab('', { you: 'yes', ss: 1 })).toBe('people');
  });
});

describe('tabAfterKey', () => {
  it('moves with the arrows, wrapping, and jumps with Home and End', () => {
    expect(tabAfterKey('people', 'ArrowRight')).toBe('spending');
    expect(tabAfterKey('rates', 'ArrowRight')).toBe('people');
    expect(tabAfterKey('people', 'ArrowLeft')).toBe('rates');
    expect(tabAfterKey('savings', 'Home')).toBe('people');
    expect(tabAfterKey('savings', 'End')).toBe('rates');
    expect(tabAfterKey('savings', 'Enter')).toBeNull();
  });
});
