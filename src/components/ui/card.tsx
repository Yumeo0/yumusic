import type { ComponentProps } from "@solidjs/web";
import { omit } from "solid-js";

import { cn } from "@/lib/utils/utils";

function Card(props: ComponentProps<"div"> & { size?: "default" | "sm" }) {
	const rest = omit(props, "class", "size");
	return (
		<div
			class={cn(
				"ring-foreground/10 bg-card text-card-foreground gap-6 overflow-hidden rounded-2xl py-6 text-sm ring-1 has-[>img:first-child]:pt-0 data-[size=sm]:gap-4 data-[size=sm]:py-4 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl group/card flex flex-col",
				props.class,
			)}
			data-size={props.size ?? "default"}
			data-slot="card"
			{...rest}
		/>
	);
}

function CardHeader(props: ComponentProps<"div">) {
	const rest = omit(props, "class");
	return (
		<div
			class={cn(
				"gap-2 rounded-t-xl px-6 group-data-[size=sm]/card:px-4 [.border-b]:pb-6 group-data-[size=sm]/card:[.border-b]:pb-4 group/card-header @container/card-header grid auto-rows-min items-start has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto]",
				props.class,
			)}
			data-slot="card-header"
			{...rest}
		/>
	);
}

function CardTitle(props: ComponentProps<"div">) {
	const rest = omit(props, "class");
	return (
		<div
			class={cn("text-base font-medium", props.class)}
			data-slot="card-title"
			{...rest}
		/>
	);
}

function CardDescription(props: ComponentProps<"div">) {
	const rest = omit(props, "class");
	return (
		<div
			class={cn("text-muted-foreground text-sm", props.class)}
			data-slot="card-description"
			{...rest}
		/>
	);
}

function CardAction(props: ComponentProps<"div">) {
	const rest = omit(props, "class");
	return (
		<div
			class={cn(
				"col-start-2 row-span-2 row-start-1 self-start justify-self-end",
				props.class,
			)}
			data-slot="card-action"
			{...rest}
		/>
	);
}

function CardContent(props: ComponentProps<"div">) {
	const rest = omit(props, "class");
	return (
		<div
			class={cn("px-6 group-data-[size=sm]/card:px-4", props.class)}
			data-slot="card-content"
			{...rest}
		/>
	);
}

function CardFooter(props: ComponentProps<"div">) {
	const rest = omit(props, "class");
	return (
		<div
			class={cn(
				"rounded-b-xl px-6 group-data-[size=sm]/card:px-4 [.border-t]:pt-6 group-data-[size=sm]/card:[.border-t]:pt-4 flex items-center",
				props.class,
			)}
			data-slot="card-footer"
			{...rest}
		/>
	);
}

export {
	Card,
	CardAction,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
};
