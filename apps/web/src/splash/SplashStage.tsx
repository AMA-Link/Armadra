import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react";
import idleAnimalUrl from "./assets/idle-animal.png";
import logoUrl from "./assets/logo.png";
import walkerSheetUrl from "./assets/walker-sheet.png";
import { INK_PATHS, TRACE_PATH } from "./lettering";
import { splashFrameAt, type SplashFrame } from "./timeline";

/**
 * 开屏动画的画面本体：一整块 1920×1080 的 SVG。
 *
 * 它不自己走时间——父组件按帧调 `renderAt`，这里只把结果写到属性上。
 * 每帧重渲染 React 是白费的：八条字形路径每帧都一模一样，diff 的成本远大于
 * 直接改几个属性，所以这里走 ref + `setAttribute`。
 *
 * 三张位图（走姿精灵图、静止姿势、品牌标识）从设计稿里抽成了独立文件，
 * 由 Vite 当资源处理；把 1.5 MB 的 base64 塞回源码会让入口 chunk 直接翻倍。
 */

/** σ=3 的阶跃边缘在 -3σ…+3σ 七个点上的值（标准正态分布函数）。 */
const FEATHER = [0.0013, 0.0228, 0.1587, 0.5, 0.8413, 0.9772, 0.9987];
/**
 * 半径 10 的圆做 σ=7 高斯模糊后，从圆心到 31（R+3σ）九个等距点上的值；
 * 下面那条是半径 4、σ=2，到 10 为止。数值积分得出。
 */
const HALO_GLOW = [0.64, 0.586, 0.446, 0.278, 0.139, 0.055, 0.017, 0.004, 0];
const LIGHT_GLOW = [0.865, 0.812, 0.659, 0.442, 0.232, 0.092, 0.027, 0.006, 0];

export interface SplashStageHandle {
  /** 渲染 `[0, SPLASH_DURATION_MS]` 里的某一刻；越界会被夹住。 */
  renderAt: (milliseconds: number) => void;
}

interface SplashStageProps {
  ref?: Ref<SplashStageHandle>;
  /** 无障碍描述；由父组件按语言传进来。 */
  label: string;
}

export function SplashStage({ ref, label }: SplashStageProps) {
  const signature = useRef<SVGGElement>(null);
  const walker = useRef<SVGGElement>(null);
  const sheet = useRef<SVGImageElement>(null);
  const entrance = useRef<SVGRectElement>(null);
  const walking = useRef<SVGRectElement>(null);
  const resting = useRef<SVGRectElement>(null);
  const idle = useRef<SVGGElement>(null);
  const logo = useRef<SVGGElement>(null);
  const trace = useRef<SVGPathElement>(null);
  const tip = useRef<SVGGElement>(null);
  /** 中心线总长；jsdom 没有 SVG 几何，量不到就退化成「不画笔迹动画」。 */
  const traceLength = useRef(0);

  const apply = (frame: SplashFrame) => {
    signature.current?.setAttribute("transform", frame.signature);
    walker.current?.setAttribute("transform", frame.walker);
    walker.current?.setAttribute("opacity", String(frame.walkerOpacity));
    sheet.current?.setAttribute("x", String(frame.sheetX));
    sheet.current?.setAttribute("y", String(frame.sheetY));
    entrance.current?.setAttribute(
      "transform",
      `translate(${frame.entranceX} 0)`,
    );
    const seam = `translate(${frame.seam} 0)`;
    walking.current?.setAttribute("transform", seam);
    resting.current?.setAttribute("transform", seam);
    idle.current?.setAttribute("opacity", String(frame.idleOpacity));
    logo.current?.setAttribute("opacity", String(frame.logoOpacity));

    const path = trace.current;
    const length = traceLength.current;
    if (path && length > 0) {
      path.style.strokeDashoffset = String(
        length * (1 - frame.writingProgress),
      );
      path.style.visibility = frame.writingProgress > 0 ? "visible" : "hidden";
    }

    const pen = tip.current;
    if (!pen) return;
    pen.setAttribute("opacity", String(frame.tipOpacity));
    if (
      frame.tipOpacity > 0 &&
      path &&
      length > 0 &&
      typeof path.getPointAtLength === "function"
    ) {
      const point = path.getPointAtLength(length * frame.writingProgress);
      pen.setAttribute("transform", `translate(${point.x} ${point.y})`);
    }
  };

  // 量长度并落第一帧都必须在浏览器绘制之前完成，否则会闪一下写完的字。
  useLayoutEffect(() => {
    const path = trace.current;
    if (path && typeof path.getTotalLength === "function") {
      const length = path.getTotalLength();
      traceLength.current = length;
      path.style.strokeDasharray = `${length} ${length}`;
    }
    // 只在挂载时跑一次：之后的每一帧都由父组件通过 `renderAt` 推进来。
    apply(splashFrameAt(0));
  }, []);

  useImperativeHandle(ref, () => ({
    renderAt: (milliseconds: number) => apply(splashFrameAt(milliseconds)),
  }));

  return (
    <svg
      viewBox="0 0 1920 1080"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={label}
    >
      <defs>
        {/*
         * 遮罩的软边用渐变画，不用模糊滤镜：遮罩每帧都在动，滤镜意味着每帧把
         * 遮罩重新光栅化再做一次高斯模糊。两条渐变是 σ=3 高斯模糊后的阶跃边缘
         * （正态分布函数在 ±3σ 内取七个点），和原来的模糊边缘逐点对得上。
         * 坐标系跟着引用它的矩形走，矩形用 transform 平移，羽化带就跟着移动。
         */}
        <linearGradient
          id="splash-feather-rise"
          gradientUnits="userSpaceOnUse"
          x1="-9"
          x2="9"
        >
          {FEATHER.map((opacity, index) => (
            <stop
              key={index}
              offset={index / (FEATHER.length - 1)}
              stopColor="white"
              stopOpacity={opacity}
            />
          ))}
        </linearGradient>
        <linearGradient
          id="splash-feather-fall"
          gradientUnits="userSpaceOnUse"
          x1="-9"
          x2="9"
        >
          {FEATHER.map((opacity, index) => (
            <stop
              key={index}
              offset={index / (FEATHER.length - 1)}
              stopColor="white"
              stopOpacity={1 - opacity}
            />
          ))}
        </linearGradient>
        {/*
         * 入场遮罩：一块自右向左打开的窗口，先露鼻子再露壳和尾巴。矩形的
         * 原点就是左缘，右侧一直铺到遮罩区域外；上下沿也在犰狳之外，不需要软边。
         */}
        <mask
          id="splash-entrance-clip"
          maskUnits="userSpaceOnUse"
          x="600"
          y="140"
          width="700"
          height="420"
          style={{ maskType: "alpha" }}
        >
          <rect
            ref={entrance}
            fill="url(#splash-feather-rise)"
            transform="translate(990 0)"
            x="-9"
            y="140"
            width="720"
            height="420"
          />
        </mask>
        {/*
         * 走姿与静止姿势以同一道接缝分开：左边走姿、右边静止姿势，接缝一次扫
         * 过去，不做半透明叠化。两块矩形的原点都在接缝上。
         */}
        <mask
          id="splash-walking-clip"
          maskUnits="userSpaceOnUse"
          x="600"
          y="140"
          width="700"
          height="420"
          style={{ maskType: "alpha" }}
        >
          <rect
            ref={walking}
            fill="url(#splash-feather-fall)"
            transform="translate(1130 0)"
            x="-720"
            y="140"
            width="729"
            height="420"
          />
        </mask>
        <mask
          id="splash-resting-clip"
          maskUnits="userSpaceOnUse"
          x="600"
          y="140"
          width="700"
          height="420"
          style={{ maskType: "alpha" }}
        >
          <rect
            ref={resting}
            fill="url(#splash-feather-rise)"
            transform="translate(1130 0)"
            x="-9"
            y="140"
            width="720"
            height="420"
          />
        </mask>
        {/*
         * 笔尖的两层光晕：原来是实心圆加高斯模糊（r=10/σ=7、r=4/σ=2），这里
         * 换成算好的径向渐变，笔尖每帧都在移动，省掉两次逐帧模糊。
         */}
        <radialGradient id="splash-tip-halo-glow">
          {HALO_GLOW.map((opacity, index) => (
            <stop
              key={index}
              className="splash-tip-glow-stop"
              offset={index / (HALO_GLOW.length - 1)}
              stopOpacity={opacity}
            />
          ))}
        </radialGradient>
        <radialGradient id="splash-tip-light-glow">
          {LIGHT_GLOW.map((opacity, index) => (
            <stop
              key={index}
              className="splash-tip-glow-stop"
              offset={index / (LIGHT_GLOW.length - 1)}
              stopOpacity={opacity}
            />
          ))}
        </radialGradient>
      </defs>

      <rect className="splash-stage-bg" width="1920" height="1080" />

      <g mask="url(#splash-entrance-clip)">
        <g mask="url(#splash-walking-clip)">
          <g
            id="splash-walker"
            ref={walker}
            className="splash-walker"
            opacity="0"
            pointerEvents="none"
          >
            <svg
              x="-224"
              y="-134.4"
              width="368.64"
              height="245.76"
              viewBox="0 0 768 512"
              overflow="hidden"
            >
              <image
                ref={sheet}
                x="0"
                y="0"
                width="1536"
                height="1024"
                href={walkerSheetUrl}
              />
            </svg>
          </g>
        </g>
      </g>

      <g mask="url(#splash-resting-clip)">
        <g
          id="splash-idle"
          ref={idle}
          opacity="0"
          pointerEvents="none"
          transform="translate(960 345)"
        >
          <image
            x="-160"
            y="-160"
            width="320"
            height="320"
            href={idleAnimalUrl}
          />
        </g>
      </g>

      <g id="splash-logo" ref={logo} opacity="0" transform="translate(960 345)">
        <image x="-160" y="-160" width="320" height="320" href={logoUrl} />
      </g>

      <g id="splash-signature" ref={signature}>
        <defs>
          {/* 一条连续的中心线加粗成 72px，就是揭开字形的那把刷子。 */}
          <mask
            id="splash-writing-mask"
            maskUnits="userSpaceOnUse"
            x="300"
            y="340"
            width="1260"
            height="380"
          >
            <g
              fill="none"
              stroke="white"
              strokeWidth="72"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path ref={trace} d={TRACE_PATH} />
            </g>
          </mask>
        </defs>
        <g className="splash-ink" mask="url(#splash-writing-mask)">
          {INK_PATHS.map((d, index) => (
            <path key={index} d={d} />
          ))}
        </g>
        <g ref={tip} opacity="0" pointerEvents="none">
          <circle
            className="splash-tip-halo"
            r="31"
            fill="url(#splash-tip-halo-glow)"
          />
          <circle
            className="splash-tip-light"
            r="10"
            fill="url(#splash-tip-light-glow)"
          />
          <circle className="splash-tip-core" r="2.6" />
        </g>
      </g>
    </svg>
  );
}
