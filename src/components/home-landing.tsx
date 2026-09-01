"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { BookOpenText, MapPinned, Route, Send } from "lucide-react";
import { TRAVEL_EXAMPLES } from "@/lib/examples";

export default function HomeLanding() {
  const router = useRouter();
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    router.push(`/plan?q=${encodeURIComponent(value.slice(0, 2000))}`);
  };

  const applyExample = (prompt: string) => {
    setInput(prompt);
    textareaRef.current?.focus();
  };

  return <main className="home-landing">
    <header className="home-nav">
      <Link className="home-nav-brand" href="/" aria-label="回到首页">
        <span className="home-nav-mark"><Route /></span>
        <span className="home-nav-title"><strong>去野</strong><small>自驾规划</small></span>
      </Link>
      <nav className="home-nav-links" aria-label="主导航">
        <Link className="home-nav-link" href="/trips"><BookOpenText />我的行程</Link>
        <Link className="home-nav-link" href="/about">关于</Link>
      </nav>
    </header>

    <div className="home-landing-body">
      <div className="home-landing-title">
        <h1>把想去的地方，<em>排成走得通的路</em></h1>
        <p>说说你的目的地、天数和偏好，我来规划一条真实可行的自驾路线。</p>
      </div>

      <form className="home-composer" onSubmit={submit}>
        <textarea
          ref={textareaRef}
          aria-label="描述你的旅行想法"
          rows={3}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          placeholder="想去哪里？玩几天？几个人？喜欢自然、人文还是美食…"
        />
        <button aria-label="开始规划" disabled={!input.trim()}><Send /><span>开始规划</span></button>
      </form>

      <section className="home-examples" aria-label="试试这些案例">
        <small>试试这些</small>
        <div className="home-example-grid">
          {TRAVEL_EXAMPLES.map((example) => <button key={example.id} className="home-example-card" onClick={() => applyExample(example.prompt)}>
            <div className="home-example-kicker"><MapPinned /><span>{example.meta}</span></div>
            <strong>{example.title}</strong>
            <p>{example.description}</p>
            <span className="home-example-fill">填入对话 →</span>
          </button>)}
        </div>
      </section>
    </div>
  </main>;
}
