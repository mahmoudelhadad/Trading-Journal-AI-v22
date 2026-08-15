import { useState } from 'react';
import { Button } from '@components/ui/Button.js';
import { Input } from '@components/ui/Input.js';
import { Select } from '@components/ui/Select.js';
import { COLORS as C } from '@constants/lists.js';
import type { HistoricalRoot } from '@apptypes/marketData.js';
import type { ReplayImportRequest, ReplayImportResult, ReplaySnapshot } from '@apptypes/replay.js';

export function HistoricalImportPanel({ snapshot, onSeries, onImport }: {
  snapshot: ReplaySnapshot;
  onSeries(root: HistoricalRoot, expiryText: string): void;
  onImport(request: ReplayImportRequest): Promise<ReplayImportResult>;
}) {
  const [root, setRoot] = useState<HistoricalRoot>(snapshot.series.root);
  const [expiry, setExpiry] = useState(`${String(snapshot.series.expiryMonth).padStart(2, '0')}-${String(snapshot.series.expiryYear).slice(-2)}`);
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState('');
  const [preparing, setPreparing] = useState(false);
  const submit = async () => {
    if (file === null || snapshot.importing || preparing) return;
    setPreparing(true);
    setMessage('Reading and validating file…');
    try {
      const result = await onImport({ root, expiryText: expiry, text: await file.text(), fileName: file.name });
      setMessage(result.message);
    } catch {
      setMessage('The historical file could not be read.');
    } finally {
      setPreparing(false);
    }
  };
  const availability = snapshot.availability.available
    ? `${snapshot.availability.observedDays?.length ?? 0} observed UTC days · ${new Date(snapshot.availability.observedFirstUtcMs!).toISOString()} → ${new Date(snapshot.availability.observedLastUtcMs!).toISOString()}`
    : 'No local observations for the selected contract.';
  return <div style={{ display: 'grid', gap: 8 }}>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      <Select value={root} width={80} options={['NQ', 'ES']} onChange={(value) => setRoot(value as HistoricalRoot)} />
      <Input value={expiry} width={90} onChange={setExpiry} placeholder="MM-YY" />
      <input type="file" accept=".txt,.csv,text/plain" disabled={snapshot.importing || preparing} onChange={(event) => setFile(event.target.files?.[0] ?? null)} style={{ color: C.text }} />
      <Button variant="primary" disabled={file === null || snapshot.importing || preparing} onClick={submit}>{snapshot.importing ? 'Importing…' : preparing ? 'Validating…' : 'Import'}</Button>
      <Button disabled={snapshot.importing || preparing} onClick={() => onSeries(root, expiry)}>Load Series</Button>
    </div>
    <div style={{ color: C.dim, fontSize: 11 }}>{availability}</div>
    {message && <div style={{ color: C.text, fontSize: 11 }}>{message}</div>}
  </div>;
}
