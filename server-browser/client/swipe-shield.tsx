import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Animated, Platform, ScrollView, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';

/**
 * Android only. The host opens its drawers with a react-native-gesture-handler pan that may start anywhere on a phone
 * and activates after 15 dp. A core ScrollView claims a drag after the touch slop (about 8 dp) on the UI thread and asks
 * its parents not to intercept, which makes the gesture handler root cancel every gesture that has not activated yet,
 * the drawer pan included. A JS PanResponder always answers too late for that.
 *
 * So while you control the page, its picture sits in a vertical ScrollView holding a horizontal one, each with `PAD` of
 * room on both sides: whichever axis passes the slop first owns the drag (vertical swipes stay vertical), and on release
 * the drag becomes one page scroll. React Native has no position: fixed, so the picture is held in place the way sticky
 * headers are: the scroll offset drives a counter-translation through the native driver, on the UI thread in the same
 * frame as the scroll.
 */
const PAD = 2000;

export function SwipeShield({ enabled, width, height, onSwipe, children }: {
  enabled: boolean; width: number; height: number;
  /** The finger's travel in stage pixels (positive: right / down). */
  onSwipe: (dx: number, dy: number) => void;
  children: ReactNode;
}) {
  const outer = useRef<ScrollView>(null), inner = useRef<ScrollView>(null);
  const start = useRef({ x: PAD, y: PAD });
  const offset = useRef({ x: new Animated.Value(PAD), y: new Animated.Value(PAD) }).current;
  const track = useMemo(() => ({
    x: Animated.event([{ nativeEvent: { contentOffset: { x: offset.x } } }], { useNativeDriver: true }),
    y: Animated.event([{ nativeEvent: { contentOffset: { y: offset.y } } }], { useNativeDriver: true }),
  }), [offset]);
  const pinned = useMemo(() => ({ transform: [{ translateX: Animated.subtract(offset.x, PAD) }, { translateY: Animated.subtract(offset.y, PAD) }] }), [offset]);
  const center = useCallback(() => {
    outer.current?.scrollTo({ y: PAD, animated: false });
    inner.current?.scrollTo({ x: PAD, animated: false });
  }, []);
  useEffect(center, [center, width, height, enabled]);
  const begin = (axis: 'x' | 'y') => (event: NativeSyntheticEvent<NativeScrollEvent>) => { start.current[axis] = event.nativeEvent.contentOffset[axis]; };
  const end = (axis: 'x' | 'y') => (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const travel = start.current[axis] - event.nativeEvent.contentOffset[axis];
    center();
    if (Math.abs(travel) >= 1) onSwipe(axis === 'x' ? travel : 0, axis === 'y' ? travel : 0);
  };
  if (Platform.OS !== 'android' || !(width > 0 && height > 0)) return <>{children}</>;
  const common = {
    scrollEnabled: enabled, overScrollMode: 'never' as const, keyboardShouldPersistTaps: 'always' as const,
    showsHorizontalScrollIndicator: false, showsVerticalScrollIndicator: false,
  };
  return <Animated.ScrollView ref={outer} {...common} contentOffset={{ x: 0, y: PAD }} onScroll={track.y} onScrollBeginDrag={begin('y')} onScrollEndDrag={end('y')} onMomentumScrollEnd={center}
    style={{ position: 'absolute', left: 0, top: 0, width, height }} contentContainerStyle={{ width, height: height + 2 * PAD }}>
    <Animated.ScrollView ref={inner} {...common} horizontal nestedScrollEnabled contentOffset={{ x: PAD, y: 0 }} onScroll={track.x} onScrollBeginDrag={begin('x')} onScrollEndDrag={end('x')} onMomentumScrollEnd={center}
      style={{ width, height: height + 2 * PAD }} contentContainerStyle={{ width: width + 2 * PAD, height: height + 2 * PAD }}>
      <Animated.View style={[{ position: 'absolute', left: PAD, top: PAD, width, height }, pinned]}>{children}</Animated.View>
    </Animated.ScrollView>
  </Animated.ScrollView>;
}
