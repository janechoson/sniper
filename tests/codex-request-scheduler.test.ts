import assert from "node:assert/strict";
import { test } from "node:test";
import { CodexRequestScheduler } from "../src/codex-request-scheduler.js";

test("Guard outranks queued validation/learning without preempting the in-flight request",async()=>{
  const scheduler=new CodexRequestScheduler(),order:string[]=[];
  let release!:()=>void;
  const gate=new Promise<void>((resolve)=>{release=resolve;});
  const inFlight=scheduler.submit("LEARNING",async()=>{order.push("learning-active-start");await gate;order.push("learning-active-end");return 1;});
  await new Promise((resolve)=>setTimeout(resolve,0));
  const queuedLearning=scheduler.submit("LEARNING",async()=>{order.push("learning-queued");return 2;});
  const queuedValidation=scheduler.submit("VALIDATION",async()=>{order.push("validation-queued");return 3;});
  const guard=scheduler.submit("GUARD",async()=>{order.push("guard");return 4;});
  assert.deepEqual(order,["learning-active-start"]);
  release();
  await Promise.all([inFlight,queuedLearning,queuedValidation,guard]);
  assert.deepEqual(order,["learning-active-start","learning-active-end","guard","validation-queued","learning-queued"]);
  assert.equal(scheduler.status().concurrency,1);
});

test("Guard skips background debounce wait; cancelled queued work is removed",async()=>{
  const scheduler=new CodexRequestScheduler(),calls:string[]=[];
  await scheduler.submit("LEARNING",async()=>{calls.push("first-background");return true;});
  const controller=new AbortController();
  const waiting=scheduler.submit("LEARNING",async()=>{calls.push("should-not-run");return true;},{minIntervalMs:30000,signal:controller.signal});
  controller.abort();
  await assert.rejects(waiting,/CANCELLED/);
  const delayedController=new AbortController();
  const delayed=scheduler.submit("LEARNING",async()=>{calls.push("delayed-background");return true;},{minIntervalMs:30000,signal:delayedController.signal});
  const urgent=scheduler.submit("GUARD",async()=>{calls.push("urgent-guard");return true;});
  await urgent;
  assert.deepEqual(calls,["first-background","urgent-guard"]);
  assert.equal(scheduler.status().queued,1);
  assert.equal(scheduler.status().queued,1);
  delayedController.abort();
  await assert.rejects(delayed,/CANCELLED/);
  assert.equal(scheduler.status().queued,0);
});
