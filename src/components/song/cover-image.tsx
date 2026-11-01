import { type ComponentProps, useEffect, useRef, useState } from "react";
import { type CoverCrop, loadCoverCrop } from "@/lib/utils/cover-crop";

/** Crop the image contents inside its existing bounds, preserving player morphs. */
export function CoverImage({
	src,
	style,
	alt = "",
	...props
}: ComponentProps<"img">) {
	const imageRef = useRef<HTMLImageElement>(null);
	const [crop, setCrop] = useState<{
		src: string;
		value: CoverCrop | null;
	} | null>(null);
	useEffect(() => {
		if (!src) return;
		let cancelled = false;
		const image = imageRef.current;
		const analyze = () => {
			void loadCoverCrop(src).then((value) => {
				if (!cancelled) setCrop({ src, value });
			});
		};
		if (image?.complete && image.naturalWidth > 0) analyze();
		image?.addEventListener("load", analyze);
		return () => {
			cancelled = true;
			image?.removeEventListener("load", analyze);
		};
	}, [src]);
	const value = crop && crop.src === src ? crop.value : null;
	return (
		<img
			{...props}
			alt={alt}
			ref={imageRef}
			src={src}
			style={{
				...style,
				objectViewBox: value
					? `inset(${value.top * 100}% 0 ${value.bottom * 100}% 0)`
					: style?.objectViewBox,
			}}
		/>
	);
}
