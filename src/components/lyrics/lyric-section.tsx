import type { Ref } from "react";
import type { LyricSection } from "@/lib/lyrics/sections";
import { cn } from "@/lib/utils/utils";

export function LyricSectionHeading({
	section,
	isActive = false,
	onSeek,
	headingRef,
}: {
	section: LyricSection;
	isActive?: boolean;
	onSeek?: () => void;
	headingRef?: Ref<HTMLHeadingElement>;
}) {
	const content = (
		<>
			<span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.16em]">
				{section.title}
			</span>
			{section.credit && (
				<span className="min-w-0 truncate text-xs font-normal tracking-normal text-muted-foreground/70">
					{section.credit}
				</span>
			)}
			<span aria-hidden className="h-px min-w-4 flex-1 bg-foreground/10" />
		</>
	);
	return (
		<h3
			className={cn(
				"mt-6 mb-1 text-primary/75 first:mt-0",
				isActive && "text-primary",
			)}
			data-lyric-section
			ref={headingRef}
		>
			{onSeek ? (
				<button
					className="flex w-full items-center gap-3 rounded-sm py-2 text-left transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
					onClick={onSeek}
					type="button"
				>
					{content}
				</button>
			) : (
				<span className="flex items-center gap-3 py-2">{content}</span>
			)}
		</h3>
	);
}
