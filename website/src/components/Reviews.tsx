import { useEffect, useRef, useState, type FormEvent } from 'react';
import './reviews.css';

type Review = { id: string; name: string; rating: number; title: string; body: string; version: string; createdAt: string };
type Feed = {
  reviews: Review[];
  aggregate: { count: number; average: number | null; distribution: Record<string, number> };
  page: number; pageSize: number; hasMore: boolean;
};
type FormState = 'idle' | 'sending' | 'success' | 'error';
const unavailableMessage = 'Community reviews will open once the review service is connected. Nothing is rated until real people share their experience.';

function Stars({ rating }: { rating: number }) {
  return <span className="rr-stars" role="img" aria-label={`${rating} out of 5 stars`}>
    {[1, 2, 3, 4, 5].map(star => <span aria-hidden="true" className={star <= rating ? 'rr-star-filled' : ''} key={star}>★</span>)}
  </span>;
}

export default function Reviews({ version = '' }: { version?: string }) {
  const [feed, setFeed] = useState<Feed | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [ratingFilter, setRatingFilter] = useState('all');
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [rating, setRating] = useState(0);
  const [formState, setFormState] = useState<FormState>('idle');
  const [formMessage, setFormMessage] = useState('');
  const [formBody, setFormBody] = useState('');
  const [consent, setConsent] = useState(false);
  const submitController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = setTimeout(() => { controller.abort(); if (active) setState('error'); }, 15_000);
    setState('loading');
    fetch(`/api/reviews?rating=${ratingFilter}&sort=${sort}&page=${page}`, { signal: controller.signal, headers: { accept: 'application/json' } })
      .then(async response => {
        if (response.status === 503) {
          const error = await response.json().catch(() => null);
          if (active && !controller.signal.aborted) setState(error?.configured === false ? 'unavailable' : 'error');
          return;
        }
        if (!response.ok) throw new Error('UNAVAILABLE');
        const data = await response.json();
        if (data?.configured !== true || !Array.isArray(data.reviews) || !data.aggregate || typeof data.hasMore !== 'boolean') throw new Error('INVALID_RESPONSE');
        if (active && !controller.signal.aborted) { setFeed(data as Feed); setState('ready'); }
      })
      .catch(() => { if (active) setState('error'); })
      .finally(() => clearTimeout(timeout));
    return () => { active = false; clearTimeout(timeout); controller.abort(); };
  }, [ratingFilter, sort, page, reload]);

  useEffect(() => () => { const controller = submitController.current; submitController.current = null; controller?.abort(); }, []);

  function updateFilter(value: string) { setRatingFilter(value); setPage(1); }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state !== 'ready' || formState === 'sending' || submitController.current) return;
    if (rating < 1 || !consent) {
      setFormState('error');
      setFormMessage('Choose a star rating and confirm that you want to publish your review.');
      return;
    }
    const form = event.currentTarget;
    const values = new FormData(form);
    const payload = { name: String(values.get('name') || '').trim(), rating, title: String(values.get('title') || '').trim(), body: formBody.trim(), version: String(values.get('version') || '').trim(), website: String(values.get('website') || '') };
    if (payload.name.length < 2 || payload.title.length < 3 || payload.body.length < 20 || /[<>\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(payload.name + payload.title + payload.body)) {
      setFormState('error'); setFormMessage('Please use plain text, a name of at least 2 characters, a title of at least 3, and a review of at least 20.'); return;
    }
    if (!/^[a-zA-Z0-9.+ _-]{0,40}$/u.test(payload.version)) {
      setFormState('error'); setFormMessage('For the optional version, use letters, numbers, spaces, dots, plus signs, underscores or hyphens.'); return;
    }
    const controller = new AbortController();
    submitController.current = controller;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    setFormState('sending');
    setFormMessage('Sending your review…');
    try {
      const response = await fetch('/api/reviews', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload), signal: controller.signal });
      if (submitController.current !== controller) return;
      if (controller.signal.aborted) throw new Error('Submission timed out');
      if (response.status === 202) {
        setFormState('success'); setFormMessage('Thank you. Your review was received and is awaiting moderation. It will appear publicly only after approval.');
        form.reset(); setRating(0); setFormBody(''); setConsent(false);
      } else {
        setFormState('error');
        setFormMessage(response.status === 429 ? 'One review per network every 24 hours. Please try again later.'
          : response.status === 400 || response.status === 413 ? 'Please check the field lengths and use plain text. Your review was not submitted.'
            : 'The review service is temporarily unavailable. Your review has not been confirmed. Please try again later.');
      }
    } catch {
      if (submitController.current === controller) { setFormState('error'); setFormMessage('We could not confirm your submission. Please try again later; repeated submissions may be limited.'); }
    } finally { clearTimeout(timeout); if (submitController.current === controller) submitController.current = null; }
  }

  const disabled = state !== 'ready' || formState === 'sending';
  const showFeed = state === 'ready' && feed;
  return <section id="reviews" className="rr-section" aria-labelledby="reviews-title">
    <div className="rr-heading">
      <div><p className="rr-eyebrow">From the community</p><h2 id="reviews-title">Built for people.<br /><span>Better with your feedback.</span></h2></div>
      <p>Tell us what helped, what felt rough, and what should come next. Every published rating comes from a submitted community review.</p>
    </div>
    {state === 'loading' && <p className="rr-notice" role="status">Loading community reviews…</p>}
    {(state === 'unavailable' || state === 'error') && <div className="rr-notice" role="status">
      <span>{state === 'unavailable' ? unavailableMessage : 'Reviews could not load. Please try again in a moment.'}</span>
      <button className="rr-text-button" type="button" onClick={() => setReload(value => value + 1)}>Try again <span aria-hidden="true">↻</span></button>
    </div>}
    <div className="rr-layout">
      <div className="rr-community" aria-busy={state === 'loading'}>
        <div className="rr-summary">
          <div className="rr-score"><strong>{showFeed && feed.aggregate.average !== null ? feed.aggregate.average.toFixed(1) : '—'}</strong><span>/ 5</span><p>{showFeed ? `${feed.aggregate.count} published ${feed.aggregate.count === 1 ? 'review' : 'reviews'}` : 'No rating shown without live reviews'}</p></div>
          <div className="rr-distribution" aria-label="Published rating distribution">
            {[5, 4, 3, 2, 1].map(star => {
              const count = showFeed ? feed.aggregate.distribution[star] || 0 : 0;
              return <button key={star} type="button" disabled={!showFeed} aria-label={`Show ${star}-star reviews: ${count}`} aria-pressed={ratingFilter === String(star)} onClick={() => updateFilter(ratingFilter === String(star) ? 'all' : String(star))}>
                <span>{star} <span aria-hidden="true">★</span></span><progress className="rr-meter" aria-hidden="true" max={showFeed && feed.aggregate.count ? feed.aggregate.count : 1} value={count} /><span>{showFeed ? count : '—'}</span>
              </button>;
            })}
          </div>
        </div>
        <div className="rr-toolbar">
          <label>Rating<select aria-label="Filter reviews by rating" value={ratingFilter} disabled={!showFeed} onChange={event => updateFilter(event.target.value)}><option value="all">All ratings</option>{[5, 4, 3, 2, 1].map(star => <option value={star} key={star}>{star} {star === 1 ? 'star' : 'stars'}</option>)}</select></label>
          <label>Sort by<select aria-label="Sort reviews" value={sort} disabled={!showFeed} onChange={event => { setSort(event.target.value); setPage(1); }}><option value="newest">Most recent</option><option value="highest">Highest rated</option><option value="lowest">Lowest rated</option></select></label>
        </div>
        {showFeed && feed.reviews.length === 0 && <div className="rr-empty"><span aria-hidden="true">✦</span><h3>{feed.aggregate.count ? 'No reviews with this rating yet.' : 'Your experience could be the first.'}</h3><p>{feed.aggregate.count ? 'Choose another rating to explore community feedback.' : 'There are no published reviews yet. If you have tried Little Code, share an honest review.'}</p></div>}
        {showFeed && feed.reviews.length > 0 && <div className="rr-list">{feed.reviews.map(review => <article className="rr-card" key={review.id}>
          <div className="rr-card-top"><Stars rating={review.rating} /><time dateTime={review.createdAt}>{new Date(review.createdAt).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}</time></div>
          <h3>{review.title}</h3><p className="rr-review-body">{review.body}</p>
          <div className="rr-author"><span className="rr-avatar" aria-hidden="true">{review.name.slice(0, 1).toLocaleUpperCase()}</span><strong>{review.name}</strong>{review.version && <span className="rr-version">v{review.version.replace(/^v/u, '')}</span>}</div>
        </article>)}</div>}
        {showFeed && (page > 1 || feed.hasMore) && <nav className="rr-pagination" aria-label="Review pages"><button type="button" disabled={page === 1} onClick={() => setPage(value => value - 1)}>← Previous</button><span>Page {page}</span><button type="button" disabled={!feed.hasMore || page >= 100} onClick={() => setPage(value => value + 1)}>Next →</button></nav>}
        <p className="rr-footnote">Reviews are moderated for spam and personal information. Ratings reflect community opinions; installation or purchase is not independently verified.</p>
      </div>
      <form className="rr-form" onSubmit={submit} aria-labelledby="write-review-title" aria-describedby="reviews-privacy">
        <p className="rr-eyebrow">Help shape Little Code</p><h3 id="write-review-title">How was your experience?</h3>
        <p className="rr-form-intro">Useful feedback is specific. Share the little details that made a difference.</p>
        <fieldset disabled={disabled} className="rr-form-fields">
          <fieldset className="rr-rating-input"><legend>Your rating <span aria-hidden="true">*</span></legend><div>{[1, 2, 3, 4, 5].map(star => <label key={star} className={star <= rating ? 'is-chosen' : ''}><input type="radio" name="rating" value={star} checked={rating === star} onChange={() => setRating(star)} required /><span aria-hidden="true">★</span><span className="rr-sr-only">{star} {star === 1 ? 'star' : 'stars'}</span></label>)}</div><p>{rating ? `${rating} out of 5` : 'Choose 1 to 5 stars'}</p></fieldset>
          <label className="rr-label">Display name <span aria-hidden="true">*</span><input name="name" autoComplete="nickname" minLength={2} maxLength={60} required placeholder="How you would like to appear" /></label>
          <label className="rr-label">Review title <span aria-hidden="true">*</span><input name="title" minLength={3} maxLength={100} required placeholder="The main thing you want to share" /></label>
          <label className="rr-label">Your review <span aria-hidden="true">*</span><textarea name="body" minLength={20} maxLength={2000} required rows={5} value={formBody} onChange={event => setFormBody(event.target.value)} placeholder="What did you build? What worked, and what could improve?" /><span className="rr-character-count">{formBody.length} / 2,000 · at least 20 characters</span></label>
          <label className="rr-label">Version tried <span className="rr-optional">optional</span><input name="version" defaultValue={version} maxLength={40} placeholder="e.g. 0.3.0" /></label>
          <div className="rr-honeypot" aria-hidden="true"><label>Website<input name="website" type="text" autoComplete="off" tabIndex={-1} /></label></div>
          <label className="rr-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} required /><span>I agree to publish my display name and review after moderation. I have left out personal details, private code and API keys.</span></label>
          <button type="submit" disabled={disabled} className="rr-submit">{formState === 'sending' ? 'Sending review…' : 'Submit for moderation'} <span aria-hidden="true">↗</span></button>
        </fieldset>
        {formMessage && <p className={`rr-form-message rr-${formState}`} role={formState === 'error' ? 'alert' : 'status'}>{formMessage}</p>}
        <p id="reviews-privacy" className="rr-privacy">No account or email required. We store a salted network hash for a 24-hour submission limit, never your raw IP. Reviews appear only after moderation.</p>
      </form>
    </div>
  </section>;
}
