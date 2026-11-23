/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ISourceAdapter, Jurisdiction } from './source-adapter.interface.ts';
import { SscSourceAdapter } from './central/ssc.adapter.ts';
import { UpscSourceAdapter } from './central/upsc.adapter.ts';
import { RrbSourceAdapter } from './central/rrb.adapter.ts';
import { BpscSourceAdapter } from './bihar/bpsc.adapter.ts';
import { BsscSourceAdapter } from './bihar/bssc.adapter.ts';
import { UppscSourceAdapter } from './up/uppsc.adapter.ts';
import { UpssscSourceAdapter } from './up/upsssc.adapter.ts';

export class SourceAdapterRegistry {
  private adapters = new Map<string, ISourceAdapter>();

  constructor() {
    this.register(new SscSourceAdapter());
    this.register(new UpscSourceAdapter());
    this.register(new RrbSourceAdapter());
    this.register(new BpscSourceAdapter());
    this.register(new BsscSourceAdapter());
    this.register(new UppscSourceAdapter());
    this.register(new UpssscSourceAdapter());
  }

  register(adapter: ISourceAdapter): void {
    this.adapters.set(adapter.sourceId, adapter);
  }

  unregister(sourceId: string): boolean {
    return this.adapters.delete(sourceId);
  }

  get(sourceId: string): ISourceAdapter | undefined {
    return this.adapters.get(sourceId);
  }

  getAll(): ISourceAdapter[] {
    return Array.from(this.adapters.values());
  }

  getByJurisdiction(jurisdiction: Jurisdiction): ISourceAdapter[] {
    return this.getAll().filter((a) => a.jurisdiction === jurisdiction);
  }
}

export const sourceRegistry = new SourceAdapterRegistry();
