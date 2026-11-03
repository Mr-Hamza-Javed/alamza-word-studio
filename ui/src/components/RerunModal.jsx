import { useState } from "react";
import { RotateCw } from "lucide-react";
import { api } from "../lib/api";
import { toast, useStore } from "../lib/store";
import ModelPicker from "./ModelPicker";
import JobOptions, { pickJobSettings } from "./JobOptions";
import { Modal } from "./ui";

export default function RerunModal({ job, onClose }) {
  const models = useStore((s) => s.models);
  const system = useStore((s) => s.system);
  const settings = useStore((s) => s.settings);
  const [opts, setOpts] = useState(() => ({ ...pickJobSettings(settings), ...pickJobSettings({ ...settings, ...job.settings }) }));
  const [busy, setBusy] = useState(false);

  async function go() {
    setBusy(true);
    try {
      await api.post(`/api/jobs/${job.id}/retry`, opts);
      toast("Re-queued with new settings", "success");
      onClose();
      location.hash = `#/job/${job.id}`;
    } catch (e) {
      toast(e.message, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal wide title={`Re-run “${job.name}”`} icon={<RotateCw style={{ width: 18, color: "var(--accent)" }} />} onClose={onClose}
      footer={<><span className="muted grow" style={{ fontSize: 12 }}>This replaces the current transcript and any edits.</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={go}><RotateCw />Re-run</button></>}>
      <div className="col" style={{ gap: 14 }}>
        <ModelPicker models={models} value={opts.model} onChange={(id) => setOpts({ ...opts, model: id })} audioSeconds={job.duration} cores={system?.cores} />
        <JobOptions value={opts} onChange={setOpts} />
      </div>
    </Modal>
  );
}
