import Link from "next/link";
import { ArrowRight, Route, MapPinned, MessageCircle, Sparkles, Map, Users, Globe, BookOpenText } from "lucide-react";

export const metadata = {
  title: "关于去野 · 产品远景",
  description: "去野的产品理念与未来方向",
};

export default function AboutPage() {
  return (
    <main className="about-shell">
      <header className="about-nav">
        <Link className="about-nav-brand" href="/">
          <span className="about-nav-mark"><Route /></span>
          <span className="about-nav-title"><strong>去野</strong><small>自驾规划</small></span>
        </Link>
        <nav className="about-nav-links">
          <Link className="about-nav-link" href="/trips"><BookOpenText />我的行程</Link>
          <Link className="about-nav-link about-nav-link-active" href="/about">关于</Link>
        </nav>
      </header>

      <section className="about-hero">
        <div className="about-hero-inner">
          <span className="about-eyebrow">VISION</span>
          <h1>旅行规划，不该是<br /><em>填表格这件事</em></h1>
          <p>去野从一个问题出发：为什么订好机票酒店之后，"去哪玩、怎么玩"还是要靠人肉搜索和经验拼凑？</p>
        </div>
      </section>

      <section className="about-content">
        <div className="about-section">
          <div className="about-section-label"><span>01</span><small>WHY</small></div>
          <div className="about-section-body">
            <h2>旅行信息过载，但决策依然靠人</h2>
            <p>小红书上有无数攻略，导航 App 能实时避堵，地图软件收录了几乎每一家餐厅——但把"想去哪里"变成"第一天走哪条路、住哪个镇"，依然需要大量手工整合。</p>
            <p>去野想解决的就是这个中间地带：把碎片化的偏好、约束和地理信息，自动整合成一条真实可行的路线，而不只是一份清单。</p>
          </div>
        </div>

        <div className="about-section">
          <div className="about-section-label"><span>02</span><small>HOW</small></div>
          <div className="about-section-body">
            <h2>对话代替表单</h2>
            <p>传统规划工具要求你在开始前就想清楚所有参数。去野反过来——先开始对话，在聊天中渐进补充目的地、天数、同行人数、驾驶习惯和兴趣偏好，Agent 把每一个决定实时整理成需求摘要，直到信息足够了再生成路线。</p>
            <p>生成后可以继续对话修改："第二天太累了"、"能不能加一个温泉"——每次修改都会在确认前展示影响范围，不会静默覆盖已有安排。</p>
          </div>
        </div>

        <div className="about-section">
          <div className="about-section-label"><span>03</span><small>WHAT</small></div>
          <div className="about-section-body">
            <h2>路线可以被信任</h2>
            <p>去野生成的路线不只是景点列表。每段驾驶距离和时长由真实地图服务计算，估算项会明确标注，住宿安排会考虑当天的总里程和疲劳度，沿途问题（绕路、强度过高）会在路书里主动提示。</p>
            <p>我们相信，一份好的路书应该让人出发时心里有底，而不是到了地方才发现走不通。</p>
          </div>
        </div>

        <div className="about-features">
          <div className="about-feature-card">
            <span className="about-feature-icon"><MessageCircle /></span>
            <h3>渐进式对话</h3>
            <p>不需要一次填完所有信息，边聊边补充，Agent 自动整理需求。</p>
          </div>
          <div className="about-feature-card">
            <span className="about-feature-icon"><Map /></span>
            <h3>真实路线校验</h3>
            <p>驾驶距离和时长由地图服务计算，估算项明确标注，不靠拍脑袋。</p>
          </div>
          <div className="about-feature-card">
            <span className="about-feature-icon"><Sparkles /></span>
            <h3>修改前先预览</h3>
            <p>每次调整都会展示影响范围，确认后再执行，不会静默覆盖原有安排。</p>
          </div>
          <div className="about-feature-card">
            <span className="about-feature-icon"><MapPinned /></span>
            <h3>路书可以带走</h3>
            <p>生成后自动保存，支持导出 Excel / PDF，也可以生成只读分享链接。</p>
          </div>
        </div>

        <div className="about-section">
          <div className="about-section-label"><span>04</span><small>NEXT</small></div>
          <div className="about-section-body">
            <h2>我们还在路上</h2>
            <p>去野目前专注于国内自驾场景。未来我们想把同样的思路延伸到更多出行方式——公共交通、徒步、骑行——以及更多地区的路线数据。</p>
            <p>如果你在使用中遇到了"走不通的路线"或者"说不清楚的需求"，这些反馈对我们来说比任何功能提案都更有价值。</p>
            <div className="about-cta">
              <Link href="/" className="about-cta-primary"><Sparkles />开始规划<ArrowRight /></Link>
              <Link href="/trips" className="about-cta-secondary"><BookOpenText />我的行程</Link>
            </div>
          </div>
        </div>
      </section>

      <footer className="about-page-footer">
        <div className="about-footer-brand">
          <span className="about-nav-mark"><Route /></span>
          <span>去野 · 智能自驾旅行规划</span>
        </div>
        <p>路线与车程由地图服务计算；估算项会明确标记。</p>
      </footer>
    </main>
  );
}
