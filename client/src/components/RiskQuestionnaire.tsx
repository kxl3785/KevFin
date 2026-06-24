import { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  QUESTIONS, scoreToProfile, ASSET_CLASS_META, MIN_SCORE, MAX_SCORE,
  type ProfileId, type RiskProfile,
} from '../lib/riskProfiles.ts';

// A stepped risk-tolerance questionnaire. One question per step with a progress
// bar; the final step shows the recommended profile and its model allocation,
// which the user can apply (persisted by the caller).
export default function RiskQuestionnaire({ initialProfile, onClose, onApply }: {
  initialProfile?: ProfileId | null;
  onClose: () => void;
  onApply: (id: ProfileId) => void;
}) {
  // answers[i] = points chosen for QUESTIONS[i], or undefined if unanswered.
  const [answers, setAnswers] = useState<(number | undefined)[]>(() => QUESTIONS.map(() => undefined));
  const [step, setStep] = useState(0);
  const total = QUESTIONS.length;
  const onResult = step >= total;

  const score = answers.reduce<number>((s, p) => s + (p ?? 0), 0);
  const profile: RiskProfile = scoreToProfile(score);
  // Position on the 0–100 risk scale, for the result meter.
  const meter = ((score - MIN_SCORE) / (MAX_SCORE - MIN_SCORE)) * 100;

  function choose(points: number) {
    setAnswers(prev => { const next = [...prev]; next[step] = points; return next; });
    // Auto-advance to the next question (or the result).
    setTimeout(() => setStep(s => s + 1), 160);
  }

  const q = QUESTIONS[step];
  const progress = onResult ? 100 : (step / total) * 100;

  return createPortal(
    <div onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 4300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}>
      <div onClick={e => e.stopPropagation()}
        style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, width: 'min(520px, 95vw)', maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 24px 60px rgba(0,0,0,0.6)', padding: 24 }}>

        {/* Header + progress */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700 }}>Risk tolerance</h3>
          <span style={{ fontSize: 12, color: 'var(--muted)' }}>
            {onResult ? 'Your result' : `Question ${step + 1} of ${total}`}
          </span>
        </div>
        <div style={{ height: 6, background: 'var(--bg)', borderRadius: 3, overflow: 'hidden', marginBottom: 22 }}>
          <div style={{ width: `${progress}%`, height: '100%', background: 'var(--accent)', transition: 'width .2s ease' }} />
        </div>

        {!onResult ? (
          <>
            <p style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4, marginBottom: q.help ? 6 : 16 }}>{q.prompt}</p>
            {q.help && <p style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 16, lineHeight: 1.5 }}>{q.help}</p>}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {q.options.map(opt => {
                const on = answers[step] === opt.points;
                return (
                  <button key={opt.label} onClick={() => choose(opt.points)}
                    style={{
                      textAlign: 'left', padding: '12px 14px', borderRadius: 10, fontSize: 13.5, lineHeight: 1.4,
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                      background: on ? 'var(--accent-dim)' : 'var(--bg)',
                      color: 'var(--text)', cursor: 'pointer',
                    }}>
                    {opt.label}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 20 }}>
              <button className="btn-ghost" onClick={() => (step === 0 ? onClose() : setStep(s => s - 1))} style={{ fontSize: 13, padding: '8px 14px' }}>
                {step === 0 ? 'Cancel' : '← Back'}
              </button>
              <button className="btn-ghost" disabled={answers[step] === undefined} onClick={() => setStep(s => s + 1)} style={{ fontSize: 13, padding: '8px 14px' }}>
                Skip →
              </button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 6 }}>Based on your answers, your risk profile is</p>
            <h2 style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.4px', marginBottom: 8 }}>{profile.name}</h2>
            <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.55, marginBottom: 18 }}>{profile.blurb}</p>

            {/* Conservative → Aggressive position meter */}
            <div style={{ marginBottom: 22 }}>
              <div style={{ height: 8, borderRadius: 4, background: 'linear-gradient(90deg, #4ade80, #fbbf24, #f87171)', position: 'relative' }}>
                <div style={{ position: 'absolute', top: -3, left: `calc(${Math.max(0, Math.min(100, meter))}% - 7px)`, width: 14, height: 14, borderRadius: '50%', background: '#fff', border: '2px solid var(--bg)', boxShadow: '0 1px 4px rgba(0,0,0,0.5)' }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>
                <span>Conservative</span><span>Aggressive</span>
              </div>
            </div>

            <p style={{ fontSize: 12, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>Recommended allocation</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginBottom: 22 }}>
              {ASSET_CLASS_META.filter(m => profile.model[m.key] > 0).map(m => {
                const pct = profile.model[m.key];
                return (
                  <div key={m.key} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ width: 120, fontSize: 12.5, flexShrink: 0 }}>{m.label}</span>
                    <div style={{ flex: 1, height: 10, background: 'var(--bg)', borderRadius: 5, overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', background: m.color }} />
                    </div>
                    <span style={{ width: 38, textAlign: 'right', fontSize: 12.5, color: 'var(--muted)', flexShrink: 0 }}>{pct}%</span>
                  </div>
                );
              })}
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between' }}>
              <button className="btn-ghost" onClick={() => setStep(0)} style={{ fontSize: 13, padding: '8px 14px' }}>↺ Retake</button>
              <button className="btn-primary" onClick={() => { onApply(profile.id); onClose(); }} style={{ fontSize: 13, padding: '8px 16px' }}>
                {initialProfile === profile.id ? 'Keep this profile' : 'Use this profile'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
