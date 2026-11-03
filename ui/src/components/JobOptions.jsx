import { useState } from "react";
import { ChevronRight, Users } from "lucide-react";
import { useStore } from "../lib/store";
import { Field, NumberInput, Select, Toggle } from "./ui";

/** Language, speaker detection, alignment and advanced decoding options for a job. */
export default function JobOptions({ value, onChange }) {
  const languages = useStore((s) => s.languages);
  const alignModels = useStore((s) => s.alignModels);
  const models = useStore((s) => s.models);
  const settings = useStore((s) => s.settings);
  const system = useStore((s) => s.system);
  const [adv, setAdv] = useState(false);
  const set = (k) => (v) => onChange({ ...value, [k]: v });
  const model = models.find((m) => m.id === value.model);
  const englishOnly = model?.english_only;

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="grid-2">
        <Field label="Language" hint={englishOnly ? "This model only understands English." : "Auto-detect works, but choosing is faster and more reliable."}>
          <Select
            value={englishOnly ? "en" : value.language} onChange={set("language")} disabled={englishOnly}
            options={Object.entries(languages).map(([k, v]) => ({ value: k, label: v }))}
          />
        </Field>
        <Field label="Word timing precision" hint="Precise uses a larger aligner for tighter word timestamps (English).">
          <Select value={value.align_model} onChange={set("align_model")} options={Object.entries(alignModels).map(([k, v]) => ({ value: k, label: v }))} />
        </Field>
      </div>

      <Field label="Context prompt" hint="Names, brands or terms that appear in the audio. Helps spelling (e.g. “Hamza, Alamza, WhisperX”).">
        <input className="input" value={value.initial_prompt || ""} onChange={(e) => set("initial_prompt")(e.target.value)} placeholder="Optional: key names and terms…" />
      </Field>

      <div className="card" style={{ padding: 12, boxShadow: "none" }}>
        <Toggle
          checked={value.diarize} onChange={set("diarize")}
          label={<span className="row" style={{ gap: 6 }}><Users style={{ width: 15, height: 15 }} />Speaker detection</span>}
          hint={settings?.hf_token_set ? "Labels who is speaking. Adds processing time." : "Needs a free Hugging Face token. Add it in Settings → Speakers."}
        />
        {value.diarize && (
          <div className="grid-2" style={{ marginTop: 12 }}>
            <Field label="Min speakers" hint="0 = auto"><NumberInput value={value.min_speakers} min={0} max={20} onChange={set("min_speakers")} /></Field>
            <Field label="Max speakers" hint="0 = auto"><NumberInput value={value.max_speakers} min={0} max={20} onChange={set("max_speakers")} /></Field>
          </div>
        )}
        {value.diarize && !settings?.hf_token_set && (
          <div className="callout warn" style={{ marginTop: 10 }}>
            <span>No Hugging Face token saved. <a href="#/settings/speakers">Add one in Settings</a>, otherwise speaker detection is skipped.</span>
          </div>
        )}
      </div>

      <button type="button" className={`adv-toggle ${adv ? "open" : ""}`} onClick={() => setAdv(!adv)}>
        <ChevronRight />Advanced options
      </button>
      {adv && (
        <div className="col" style={{ gap: 12 }}>
          <div className="grid-4">
            <Field label="Precision" hint="int8 is fastest on CPU">
              <Select value={value.compute_type} onChange={set("compute_type")} options={[
                { value: "int8", label: "int8 (fast)" }, { value: "int8_float32", label: "int8 / float32" }, { value: "float32", label: "float32 (exact)" },
              ]} />
            </Field>
            <Field label="Batch size" hint="Higher = faster, more RAM"><NumberInput value={value.batch_size} min={1} max={32} onChange={set("batch_size")} /></Field>
            <Field label="CPU threads" hint={`0 = auto (${system?.cores || "?"} cores)`}><NumberInput value={value.threads} min={0} max={system?.threads || 64} onChange={set("threads")} /></Field>
            <Field label="Beam size" hint="5 = default quality"><NumberInput value={value.beam_size} min={1} max={10} onChange={set("beam_size")} /></Field>
          </div>
          <div className="grid-3">
            <Field label="Voice detection onset" hint="Higher ignores more noise">
              <NumberInput value={value.vad_onset} min={0.05} max={0.95} step={0.05} onChange={set("vad_onset")} />
            </Field>
            <Field label="Voice detection offset">
              <NumberInput value={value.vad_offset} min={0.05} max={0.95} step={0.05} onChange={set("vad_offset")} />
            </Field>
            <Field label="Chunk length (s)" hint="Max audio per segment">
              <NumberInput value={value.chunk_size} min={5} max={30} onChange={set("chunk_size")} />
            </Field>
          </div>
          <Field label="Hotwords" hint="Words to bias towards (comma separated).">
            <input className="input" value={value.hotwords || ""} onChange={(e) => set("hotwords")(e.target.value)} placeholder="e.g. WhisperX, Lenovo" />
          </Field>
          <Toggle checked={value.keep_models_loaded} onChange={set("keep_models_loaded")} label="Keep model in memory" hint="Next file starts instantly. Turn off to free RAM after each job." />
        </div>
      )}
    </div>
  );
}

export const JOB_KEYS = ["model", "language", "compute_type", "batch_size", "threads", "beam_size", "align_model", "initial_prompt",
  "hotwords", "vad_onset", "vad_offset", "chunk_size", "diarize", "min_speakers", "max_speakers", "keep_models_loaded"];

export function pickJobSettings(s) {
  const out = {};
  JOB_KEYS.forEach((k) => (out[k] = s?.[k]));
  return out;
}
