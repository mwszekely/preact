import type { ComponentChildren } from '../index2';
import type { VNode } from '../internal';

export function toChildArray(
	children: ComponentChildren,
	out: (VNode | string | number)[]
): Array<VNode | string | number> {
	out = out || [];
	if (children == null || typeof children == 'boolean') {
	} else if (Array.isArray(children)) {
		children.some(child => {
			toChildArray(child, out);
		});
	} else {
		out.push(children as VNode);
	}
	return out;
}
