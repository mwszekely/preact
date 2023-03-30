import type {
	PreactElement,
	VNode,
	Component,
	ComponentChildren
} from '../internal';
import { EMPTY_ARR, EMPTY_OBJ } from '../constants';
import { Fragment, createVNode } from '../create-element';
import { diffProps, setProperty } from './props';
import { assign, removeNode, slice } from '../util';
import { getDomSibling } from '../get-dom-sibling';
import options from '../options';

/**
 * Diff two virtual nodes and apply proper changes to the DOM
 * @param {import('../internal').PreactElement} parentDom The parent of the DOM element
 * @param {import('../internal').VNode} newVNode The new virtual node
 * @param {import('../internal').VNode} oldVNode The old virtual node
 * @param {object} globalContext The current context object. Modified by getChildContext
 * @param {boolean} isSvg Whether or not this element is an SVG node
 * @param {Array<import('../internal').PreactElement>} excessDomChildren
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {import('../internal').PreactElement} oldDom The current attached DOM
 * element any new dom elements should be placed around. Likely `null` on first
 * render (except when hydrating). Can be a sibling DOM element when diffing
 * Fragments that have siblings. In most cases, it starts out as `oldChildren[0]._dom`.
 * @param {boolean} [isHydrating] Whether or not we are in hydration
 */
export function diff(
	parentDom: PreactElement,
	newVNode: VNode,
	oldVNode: VNode,
	globalContext: {},
	isSvg: boolean,
	excessDomChildren: PreactElement[],
	commitQueue: Component[],
	oldDom: PreactElement,
	isHydrating: boolean
) {
	let tmp,
		newType = newVNode.type;

	// When passing through createElement it assigns the object
	// constructor as undefined. This to prevent JSON-injection.
	if (newVNode.constructor !== undefined) return null;

	// If the previous diff bailed out, resume creating/hydrating.
	if (oldVNode._hydrating != null) {
		isHydrating = oldVNode._hydrating;
		oldDom = newVNode._dom = oldVNode._dom;
		// if we resume, we want the tree to be "unlocked"
		newVNode._hydrating = null;
		excessDomChildren = [oldDom];
	}

	if ((tmp = options._diff)) tmp(newVNode);

	try {
		outer: if (typeof newType == 'function') {
			let c: Component,
				isNew: boolean,
				oldProps: Component['props'],
				oldState,
				snapshot,
				clearProcessingException;
			let newProps = newVNode.props;

			// Necessary for createContext api. Setting this property will pass
			// the context value as `this.context` just for this component.
			tmp = newType.contextType;
			let provider = tmp && globalContext[tmp._id];
			let componentContext = tmp
				? provider
					? provider.props.value
					: tmp._defaultValue
				: globalContext;

			// Get component and set it to `c`
			if (oldVNode._component) {
				c = newVNode._component = oldVNode._component;
				clearProcessingException = c._processingException = c._pendingError;
			} else {
				// Instantiate the new component
				if ('prototype' in newType && newType.prototype.render) {
					// @ts-ignore The check above verifies that newType is suppose to be constructed
					newVNode._component = c = new newType(newProps, componentContext); // eslint-disable-line new-cap
				} else {
					// @ts-ignore Trust me, Component implements the interface we want
					newVNode._component = c = new Component(newProps, componentContext);
					c.constructor = newType;
					c.render = doRender;
				}
				if (provider) provider.sub(c);

				c.props = newProps;
				if (!c.state) c.state = {};
				c.context = componentContext;
				c._globalContext = globalContext;
				isNew = c._dirty = true;
				c._renderCallbacks = [];
				c._stateCallbacks = [];
			}

			// Invoke getDerivedStateFromProps
			if (c._nextState == null) {
				c._nextState = c.state;
			}

			if (newType.getDerivedStateFromProps != null) {
				if (c._nextState == c.state) {
					c._nextState = assign({}, c._nextState);
				}

				assign(
					c._nextState,
					newType.getDerivedStateFromProps(newProps, c._nextState)
				);
			}

			oldProps = c.props;
			oldState = c.state;
			c._vnode = newVNode;

			// Invoke pre-render lifecycle methods
			if (isNew) {
				if (
					newType.getDerivedStateFromProps == null &&
					c.componentWillMount != null
				) {
					c.componentWillMount();
				}

				if (c.componentDidMount != null) {
					c._renderCallbacks.push(c.componentDidMount);
				}
			} else {
				if (
					newType.getDerivedStateFromProps == null &&
					newProps !== oldProps &&
					c.componentWillReceiveProps != null
				) {
					c.componentWillReceiveProps(newProps, componentContext);
				}

				if (
					(!c._force &&
						c.shouldComponentUpdate != null &&
						c.shouldComponentUpdate(
							newProps,
							c._nextState,
							componentContext
						) === false) ||
					newVNode._original === oldVNode._original
				) {
					// More info about this here: https://gist.github.com/JoviDeCroock/bec5f2ce93544d2e6070ef8e0036e4e8
					if (newVNode._original !== oldVNode._original) {
						// When we are dealing with a bail because of sCU we have to update
						// the props, state and dirty-state.
						// when we are dealing with strict-equality we don't as the child could still
						// be dirtied see #3883
						c.props = newProps;
						c.state = c._nextState;
						c._dirty = false;
					}

					// In cases of bailing due to strict-equality we have to reset force as well
					c._force = false;
					newVNode._dom = oldVNode._dom;
					newVNode._children = oldVNode._children;
					newVNode._children.forEach(vnode => {
						if (vnode) vnode._parent = newVNode;
					});

					for (let i = 0; i < c._stateCallbacks.length; i++) {
						c._renderCallbacks.push(c._stateCallbacks[i]);
					}
					c._stateCallbacks = [];

					if (c._renderCallbacks.length) {
						commitQueue.push(c);
					}

					break outer;
				}

				if (c.componentWillUpdate != null) {
					c.componentWillUpdate(newProps, c._nextState, componentContext);
				}

				if (c.componentDidUpdate != null) {
					c._renderCallbacks.push(() => {
						c.componentDidUpdate(oldProps, oldState, snapshot);
					});
				}
			}

			c.context = componentContext;
			c.props = newProps;
			c._parentDom = parentDom;

			let renderHook = options._render,
				count = 0;
			if ('prototype' in newType && newType.prototype.render) {
				c.state = c._nextState;
				c._dirty = false;

				if (renderHook) renderHook(newVNode);

				tmp = c.render(c.props, c.state, c.context);

				for (let i = 0; i < c._stateCallbacks.length; i++) {
					c._renderCallbacks.push(c._stateCallbacks[i]);
				}
				c._stateCallbacks = [];
			} else {
				do {
					c._dirty = false;
					if (renderHook) renderHook(newVNode);

					tmp = c.render(c.props, c.state, c.context);

					// Handle setState called in render, see #2553
					c.state = c._nextState;
				} while (c._dirty && ++count < 25);
			}

			// Handle setState called in render, see #2553
			c.state = c._nextState;

			if (c.getChildContext != null) {
				globalContext = assign(assign({}, globalContext), c.getChildContext());
			}

			if (!isNew && c.getSnapshotBeforeUpdate != null) {
				snapshot = c.getSnapshotBeforeUpdate(oldProps, oldState);
			}

			let isTopLevelFragment =
				tmp != null && tmp.type === Fragment && tmp.key == null;
			let renderResult = isTopLevelFragment ? tmp.props.children : tmp;

			diffChildren(
				parentDom,
				Array.isArray(renderResult) ? renderResult : [renderResult],
				newVNode,
				oldVNode,
				globalContext,
				isSvg,
				excessDomChildren,
				commitQueue,
				oldDom,
				isHydrating
			);

			c.base = newVNode._dom;

			// We successfully rendered this VNode, unset any stored hydration/bailout state:
			newVNode._hydrating = null;

			if (c._renderCallbacks.length) {
				commitQueue.push(c);
			}

			if (clearProcessingException) {
				c._pendingError = c._processingException = null;
			}

			c._force = false;
		} else if (
			excessDomChildren == null &&
			newVNode._original === oldVNode._original
		) {
			newVNode._children = oldVNode._children;
			newVNode._dom = oldVNode._dom;
		} else {
			newVNode._dom = diffElementNodes(
				oldVNode._dom,
				newVNode,
				oldVNode,
				globalContext,
				isSvg,
				excessDomChildren,
				commitQueue,
				isHydrating
			);
		}

		if ((tmp = options.diffed)) tmp(newVNode);
	} catch (e) {
		newVNode._original = null;
		// if hydrating or creating initial tree, bailout preserves DOM:
		if (isHydrating || excessDomChildren != null) {
			newVNode._dom = oldDom;
			newVNode._hydrating = !!isHydrating;
			excessDomChildren[excessDomChildren.indexOf(oldDom)] = null;
			// ^ could possibly be simplified to:
			// excessDomChildren.length = 0;
		}
		options._catchError(e, newVNode, oldVNode, undefined);
	}
}

/**
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {import('../internal').VNode} root
 */
export function commitRoot(commitQueue: Component[], root: VNode) {
	if (options._commit) options._commit(root, commitQueue);

	commitQueue.some(c => {
		try {
			// @ts-ignore Reuse the commitQueue variable here so the type changes
			commitQueue = c._renderCallbacks;
			c._renderCallbacks = [];
			commitQueue.some(cb => {
				// @ts-ignore See above ts-ignore on commitQueue
				cb.call(c);
			});
		} catch (e) {
			options._catchError(e, c._vnode, undefined, undefined);
		}
	});
}

/**
 * Diff two virtual nodes representing DOM element
 * @param {import('../internal').PreactElement} dom The DOM element representing
 * the virtual nodes being diffed
 * @param {import('../internal').VNode} newVNode The new virtual node
 * @param {import('../internal').VNode} oldVNode The old virtual node
 * @param {object} globalContext The current context object
 * @param {boolean} isSvg Whether or not this DOM node is an SVG node
 * @param {*} excessDomChildren
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {boolean} isHydrating Whether or not we are in hydration
 * @returns {import('../internal').PreactElement}
 */
function diffElementNodes(
	dom: PreactElement,
	newVNode: VNode,
	oldVNode: VNode,
	globalContext: {},
	isSvg: boolean,
	excessDomChildren: PreactElement[],
	commitQueue: Component[],
	isHydrating: boolean
): PreactElement {
	let oldProps: any = oldVNode.props;
	let newProps: any = newVNode.props;
	let nodeType = newVNode.type;
	let i: number | ComponentChildren = 0;

	// Tracks entering and exiting SVG namespace when descending through the tree.
	if (nodeType === 'svg') isSvg = true;

	if (excessDomChildren != null) {
		for (; i < excessDomChildren.length; i++) {
			const child = excessDomChildren[i];

			// if newVNode matches an element in excessDomChildren or the `dom`
			// argument matches an element in excessDomChildren, remove it from
			// excessDomChildren so it isn't later removed in diffChildren
			if (
				child &&
				'setAttribute' in child === !!nodeType &&
				(nodeType ? child.localName === nodeType : child.nodeType === 3)
			) {
				dom = child;
				excessDomChildren[i] = null;
				break;
			}
		}
	}

	if (dom == null) {
		if (nodeType === null) {
			// @ts-ignore createTextNode returns Text, we expect PreactElement
			return document.createTextNode(newProps);
		}

		if (isSvg) {
			dom = document.createElementNS(
				'http://www.w3.org/2000/svg',
				// @ts-ignore We know `newVNode.type` is a string
				nodeType
			);
		} else {
			dom = document.createElement(
				// @ts-ignore We know `newVNode.type` is a string
				nodeType,
				newProps.is && newProps
			);
		}

		// we created a new parent, so none of the previously attached children can be reused:
		excessDomChildren = null;
		// we are creating a new node, so we can assume this is a new subtree (in case we are hydrating), this deopts the hydrate
		isHydrating = false;
	}

	if (nodeType === null) {
		// During hydration, we still have to split merged text from SSR'd HTML.
		if (oldProps !== newProps && (!isHydrating || dom.data !== newProps)) {
			dom.data = newProps;
		}
	} else {
		// If excessDomChildren was not null, repopulate it with the current element's children:
		excessDomChildren = excessDomChildren && slice.call(dom.childNodes);

		oldProps = oldVNode.props || EMPTY_OBJ;

		let oldHtml = oldProps.dangerouslySetInnerHTML;
		let newHtml = newProps.dangerouslySetInnerHTML;

		// During hydration, props are not diffed at all (including dangerouslySetInnerHTML)
		// @TODO we should warn in debug mode when props don't match here.
		if (!isHydrating) {
			// But, if we are in a situation where we are using existing DOM (e.g. replaceNode)
			// we should read the existing DOM attributes to diff them
			if (excessDomChildren != null) {
				oldProps = {};
				for (i = 0; i < dom.attributes.length; i++) {
					oldProps[dom.attributes[i].name] = dom.attributes[i].value;
				}
			}

			if (newHtml || oldHtml) {
				// Avoid re-applying the same '__html' if it did not changed between re-render
				if (
					!newHtml ||
					((!oldHtml || newHtml.__html != oldHtml.__html) &&
						newHtml.__html !== dom.innerHTML)
				) {
					dom.innerHTML = (newHtml && newHtml.__html) || '';
				}
			}
		}

		diffProps(dom, newProps, oldProps, isSvg, isHydrating);

		// If the new vnode didn't have dangerouslySetInnerHTML, diff its children
		if (newHtml) {
			newVNode._children = [];
		} else {
			i = newVNode.props.children;
			diffChildren(
				dom,
				Array.isArray(i) ? i : [i],
				newVNode,
				oldVNode,
				globalContext,
				isSvg && nodeType !== 'foreignObject',
				excessDomChildren,
				commitQueue,
				excessDomChildren
					? excessDomChildren[0]
					: oldVNode._children && getDomSibling(oldVNode, 0),
				isHydrating
			);

			// Remove children that are not part of any vnode.
			if (excessDomChildren != null) {
				for (i = excessDomChildren.length; i--; ) {
					if (excessDomChildren[i] != null) removeNode(excessDomChildren[i]);
				}
			}
		}

		// (as above, don't diff props during hydration)
		if (!isHydrating) {
			if (
				'value' in newProps &&
				(i = newProps.value) !== undefined &&
				// #2756 For the <progress>-element the initial value is 0,
				// despite the attribute not being present. When the attribute
				// is missing the progress bar is treated as indeterminate.
				// To fix that we'll always update it when it is 0 for progress elements
				(i !== dom.value ||
					(nodeType === 'progress' && !i) ||
					// This is only for IE 11 to fix <select> value not being updated.
					// To avoid a stale select value we need to set the option.value
					// again, which triggers IE11 to re-evaluate the select value
					(nodeType === 'option' && i !== oldProps.value))
			) {
				setProperty(dom, 'value', i, oldProps.value, false);
			}
			if (
				'checked' in newProps &&
				(i = newProps.checked) !== undefined &&
				i !== dom.checked
			) {
				setProperty(dom, 'checked', i, oldProps.checked, false);
			}
		}
	}

	return dom;
}

/**
 * Invoke or update a ref, depending on whether it is a function or object ref.
 * @param {object|function} ref
 * @param {any} value
 * @param {import('../internal').VNode} vnode
 */
export function applyRef(ref, value, vnode) {
	try {
		if (typeof ref == 'function') ref(value);
		else ref.current = value;
	} catch (e) {
		options._catchError(e, vnode, undefined, undefined);
	}
}

/**
 * Unmount a virtual node from the tree and apply DOM changes
 * @param {import('../internal').VNode} vnode The virtual node to unmount
 * @param {import('../internal').VNode} parentVNode The parent of the VNode that
 * initiated the unmount
 * @param {boolean} [skipRemove] Flag that indicates that a parent node of the
 * current element is already detached from the DOM.
 */
export function unmount(vnode: VNode, parentVNode: VNode, skipRemove = false) {
	let r;
	if (options.unmount) options.unmount(vnode);

	if ((r = vnode.ref)) {
		if (!r.current || r.current === vnode._dom) {
			applyRef(r, null, parentVNode);
		}
	}

	if ((r = vnode._component) != null) {
		if (r.componentWillUnmount) {
			try {
				r.componentWillUnmount();
			} catch (e) {
				options._catchError(e, parentVNode, undefined, undefined);
			}
		}

		r.base = r._parentDom = null;
		vnode._component = undefined;
	}

	if ((r = vnode._children)) {
		for (let i = 0; i < r.length; i++) {
			if (r[i]) {
				unmount(
					r[i],
					parentVNode,
					skipRemove || typeof vnode.type !== 'function'
				);
			}
		}
	}

	if (!skipRemove && vnode._dom != null) {
		removeNode(vnode._dom);
	}

	// Must be set to `undefined` to properly clean up `_nextDom`
	// for which `null` is a valid value. See comment in `create-element.js`
	vnode._parent = vnode._dom = vnode._nextDom = undefined;
}

/**
 * Diff the children of a virtual node
 * @param {import('../internal').PreactElement} parentDom The DOM element whose
 * children are being diffed
 * @param {import('../internal').ComponentChildren[]} renderResult
 * @param {import('../internal').VNode} newParentVNode The new virtual
 * node whose children should be diff'ed against oldParentVNode
 * @param {import('../internal').VNode} oldParentVNode The old virtual
 * node whose children should be diff'ed against newParentVNode
 * @param {object} globalContext The current context object - modified by getChildContext
 * @param {boolean} isSvg Whether or not this DOM node is an SVG node
 * @param {Array<import('../internal').PreactElement>} excessDomChildren
 * @param {Array<import('../internal').Component>} commitQueue List of components
 * which have callbacks to invoke in commitRoot
 * @param {import('../internal').PreactElement} oldDom The current attached DOM
 * element any new dom elements should be placed around. Likely `null` on first
 * render (except when hydrating). Can be a sibling DOM element when diffing
 * Fragments that have siblings. In most cases, it starts out as `oldChildren[0]._dom`.
 * @param {boolean} isHydrating Whether or not we are in hydration
 */
export function diffChildren(
	parentDom,
	renderResult,
	newParentVNode,
	oldParentVNode,
	globalContext,
	isSvg,
	excessDomChildren,
	commitQueue,
	oldDom,
	isHydrating
) {
	let i, j, oldVNode, childVNode, newDom, firstChildDom, refs;

	// This is a compression of oldParentVNode!=null && oldParentVNode != EMPTY_OBJ && oldParentVNode._children || EMPTY_ARR
	// as EMPTY_OBJ._children should be `undefined`.
	let oldChildren = (oldParentVNode && oldParentVNode._children) || EMPTY_ARR;

	let oldChildrenLength = oldChildren.length;

	newParentVNode._children = [];
	for (i = 0; i < renderResult.length; i++) {
		childVNode = renderResult[i];

		if (
			childVNode == null ||
			typeof childVNode == 'boolean' ||
			typeof childVNode == 'function'
		) {
			childVNode = newParentVNode._children[i] = null;
		}
		// If this newVNode is being reused (e.g. <div>{reuse}{reuse}</div>) in the same diff,
		// or we are rendering a component (e.g. setState) copy the oldVNodes so it can have
		// it's own DOM & etc. pointers
		else if (
			typeof childVNode == 'string' ||
			typeof childVNode == 'number' ||
			// eslint-disable-next-line valid-typeof
			typeof childVNode == 'bigint'
		) {
			childVNode = newParentVNode._children[i] = createVNode(
				null,
				childVNode,
				null,
				null,
				childVNode
			);
		} else if (Array.isArray(childVNode)) {
			childVNode = newParentVNode._children[i] = createVNode(
				Fragment,
				{ children: childVNode },
				null,
				null,
				null
			);
		} else if (childVNode._depth > 0) {
			// VNode is already in use, clone it. This can happen in the following
			// scenario:
			//   const reuse = <div />
			//   <div>{reuse}<span />{reuse}</div>
			childVNode = newParentVNode._children[i] = createVNode(
				childVNode.type,
				childVNode.props,
				childVNode.key,
				childVNode.ref ? childVNode.ref : null,
				childVNode._original
			);
		} else {
			childVNode = newParentVNode._children[i] = childVNode;
		}

		// Terser removes the `continue` here and wraps the loop body
		// in a `if (childVNode) { ... } condition
		if (childVNode == null) {
			continue;
		}

		childVNode._parent = newParentVNode;
		childVNode._depth = newParentVNode._depth + 1;

		// Check if we find a corresponding element in oldChildren.
		// If found, delete the array item by setting to `undefined`.
		// We use `undefined`, as `null` is reserved for empty placeholders
		// (holes).
		oldVNode = oldChildren[i];

		if (
			oldVNode === null ||
			(oldVNode &&
				childVNode.key == oldVNode.key &&
				childVNode.type === oldVNode.type)
		) {
			oldChildren[i] = undefined;
		} else {
			// Either oldVNode === undefined or oldChildrenLength > 0,
			// so after this loop oldVNode == null or oldVNode is a valid value.
			for (j = 0; j < oldChildrenLength; j++) {
				oldVNode = oldChildren[j];
				// If childVNode is unkeyed, we only match similarly unkeyed nodes, otherwise we match by key.
				// We always match by type (in either case).
				if (
					oldVNode &&
					childVNode.key == oldVNode.key &&
					childVNode.type === oldVNode.type
				) {
					oldChildren[j] = undefined;
					break;
				}
				oldVNode = null;
			}
		}

		oldVNode = oldVNode || EMPTY_OBJ;

		// Morph the old element into the new one, but don't append it to the dom yet
		diff(
			parentDom,
			childVNode,
			oldVNode,
			globalContext,
			isSvg,
			excessDomChildren,
			commitQueue,
			oldDom,
			isHydrating
		);

		newDom = childVNode._dom;

		if ((j = childVNode.ref) && oldVNode.ref != j) {
			if (!refs) refs = [];
			if (oldVNode.ref) refs.push(oldVNode.ref, null, childVNode);
			refs.push(j, childVNode._component || newDom, childVNode);
		}

		if (newDom != null) {
			if (firstChildDom == null) {
				firstChildDom = newDom;
			}

			if (
				typeof childVNode.type == 'function' &&
				childVNode._children === oldVNode._children
			) {
				childVNode._nextDom = oldDom = reorderChildren(
					childVNode,
					oldDom,
					parentDom
				);
			} else {
				oldDom = placeChild(
					parentDom,
					childVNode,
					oldVNode,
					oldChildren,
					newDom,
					oldDom
				);
			}

			if (typeof newParentVNode.type == 'function') {
				// Because the newParentVNode is Fragment-like, we need to set it's
				// _nextDom property to the nextSibling of its last child DOM node.
				//
				// `oldDom` contains the correct value here because if the last child
				// is a Fragment-like, then oldDom has already been set to that child's _nextDom.
				// If the last child is a DOM VNode, then oldDom will be set to that DOM
				// node's nextSibling.
				newParentVNode._nextDom = oldDom;
			}
		} else if (
			oldDom &&
			oldVNode._dom == oldDom &&
			oldDom.parentNode != parentDom
		) {
			// The above condition is to handle null placeholders. See test in placeholder.test.js:
			// `efficiently replace null placeholders in parent rerenders`
			oldDom = getDomSibling(oldVNode);
		}
	}

	newParentVNode._dom = firstChildDom;

	// Remove remaining oldChildren if there are any.
	for (i = oldChildrenLength; i--; ) {
		if (oldChildren[i] != null) {
			if (
				typeof newParentVNode.type == 'function' &&
				oldChildren[i]._dom != null &&
				oldChildren[i]._dom == newParentVNode._nextDom
			) {
				// If the newParentVNode.__nextDom points to a dom node that is about to
				// be unmounted, then get the next sibling of that vnode and set
				// _nextDom to it
				newParentVNode._nextDom = getLastDom(oldParentVNode).nextSibling;
			}

			unmount(oldChildren[i], oldChildren[i]);
		}
	}

	// Set refs only after unmount
	if (refs) {
		for (i = 0; i < refs.length; i++) {
			applyRef(refs[i], refs[++i], refs[++i]);
		}
	}
}

function reorderChildren(childVNode, oldDom, parentDom) {
	// Note: VNodes in nested suspended trees may be missing _children.
	let c = childVNode._children;
	let tmp = 0;
	for (; c && tmp < c.length; tmp++) {
		let vnode = c[tmp];
		if (vnode) {
			// We typically enter this code path on sCU bailout, where we copy
			// oldVNode._children to newVNode._children. If that is the case, we need
			// to update the old children's _parent pointer to point to the newVNode
			// (childVNode here).
			vnode._parent = childVNode;

			if (typeof vnode.type == 'function') {
				oldDom = reorderChildren(vnode, oldDom, parentDom);
			} else {
				oldDom = placeChild(parentDom, vnode, vnode, c, vnode._dom, oldDom);
			}
		}
	}

	return oldDom;
}

function placeChild(
	parentDom,
	childVNode,
	oldVNode,
	oldChildren,
	newDom,
	oldDom
) {
	let nextDom;
	if (childVNode._nextDom !== undefined) {
		// Only Fragments or components that return Fragment like VNodes will
		// have a non-undefined _nextDom. Continue the diff from the sibling
		// of last DOM child of this child VNode
		nextDom = childVNode._nextDom;

		// Eagerly cleanup _nextDom. We don't need to persist the value because
		// it is only used by `diffChildren` to determine where to resume the diff after
		// diffing Components and Fragments. Once we store it the nextDOM local var, we
		// can clean up the property
		childVNode._nextDom = undefined;
	} else if (
		oldVNode == null ||
		newDom != oldDom ||
		newDom.parentNode == null
	) {
		outer: if (oldDom == null || oldDom.parentNode !== parentDom) {
			parentDom.appendChild(newDom);
			nextDom = null;
		} else {
			// `j<oldChildrenLength; j+=2` is an alternative to `j++<oldChildrenLength/2`
			for (
				let sibDom = oldDom, j = 0;
				(sibDom = sibDom.nextSibling) && j < oldChildren.length;
				j += 1
			) {
				if (sibDom == newDom) {
					break outer;
				}
			}
			parentDom.insertBefore(newDom, oldDom);
			nextDom = oldDom;
		}
	}

	// If we have pre-calculated the nextDOM node, use it. Else calculate it now
	// Strictly check for `undefined` here cuz `null` is a valid value of `nextDom`.
	// See more detail in create-element.js:createVNode
	if (nextDom !== undefined) {
		oldDom = nextDom;
	} else {
		oldDom = newDom.nextSibling;
	}

	return oldDom;
}

/**
 * @param {import('../internal').VNode} vnode
 */
function getLastDom(vnode) {
	if (vnode.type == null || typeof vnode.type === 'string') {
		return vnode._dom;
	}

	if (vnode._children) {
		for (let i = vnode._children.length - 1; i >= 0; i--) {
			let child = vnode._children[i];
			if (child) {
				let lastDom = getLastDom(child);
				if (lastDom) {
					return lastDom;
				}
			}
		}
	}

	return null;
}

/** The `.render()` method for a PFC backing instance. */
function doRender(props, state, context) {
	return this.constructor(props, context);
}
