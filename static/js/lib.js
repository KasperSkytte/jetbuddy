// One place to import Preact from, so views never care where it lives.
import { h, render, Fragment, createContext } from '../vendor/preact.module.js';
import { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect, useContext } from '../vendor/hooks.module.js';
import htm from '../vendor/htm.module.js';

export const html = htm.bind(h);
export { h, render, Fragment, createContext, useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect, useContext };
