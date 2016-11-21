'use strict';
import { EventEmitter } from '@angular/core';
import { check, gZone, g, debounce, noop } from './utils';
import { CursorHandle } from './cursor_handle';
export class AddChange {
    constructor(index, item) {
        this.index = index;
        this.item = item;
    }
}
export class UpdateChange {
    constructor(index, item) {
        this.index = index;
        this.item = item;
    }
}
export class MoveChange {
    constructor(fromIndex, toIndex) {
        this.fromIndex = fromIndex;
        this.toIndex = toIndex;
    }
}
export class RemoveChange {
    constructor(index) {
        this.index = index;
    }
}
/**
 * Class that does a background work of observing
 * Mongo collection changes (through a cursor)
 * and notifying subscribers about them.
 */
export class MongoCursorObserver extends EventEmitter {
    constructor(cursor, _debounceMs = 50) {
        super();
        this._debounceMs = _debounceMs;
        this._lastChanges = [];
        this._ngZone = g.Zone.current;
        this._isSubscribed = false;
        check(cursor, Match.Where(MongoCursorObserver.isCursor));
        this._cursor = cursor;
    }
    static isCursor(cursor) {
        return cursor && !!cursor.observe;
    }
    subscribe(events) {
        let sub = super.subscribe(events);
        // Start processing of the cursor lazily.
        if (!this._isSubscribed) {
            this._isSubscribed = true;
            this._hCursor = this._processCursor(this._cursor);
        }
        return sub;
    }
    get lastChanges() {
        return this._lastChanges;
    }
    destroy() {
        if (this._hCursor) {
            this._hCursor.stop();
        }
        this._hCursor = null;
    }
    _processCursor(cursor) {
        // On the server side fetch data, don't observe.
        if (Meteor.isServer) {
            let changes = [];
            let index = 0;
            for (let doc of cursor.fetch()) {
                changes.push(this._addAt(doc, index++));
            }
            this.emit(changes);
            return null;
        }
        let hCurObserver = this._startCursorObserver(cursor);
        return new CursorHandle(hCurObserver);
    }
    _startCursorObserver(cursor) {
        let changes = [];
        let callEmit = () => {
            this.emit(changes.slice());
            changes.length = 0;
        };
        // Since cursor changes are now applied in bulk
        // (due to emit debouncing), scheduling macro task
        // allows us to use MeteorApp.onStable,
        // i.e. to know when the app is stable.
        let scheduleEmit = () => {
            return this._ngZone.scheduleMacroTask('emit', callEmit, null, noop);
        };
        let init = false;
        let runTask = task => {
            task.invoke();
            this._ngZone.run(noop);
            init = true;
        };
        let emit = null;
        if (this._debounceMs) {
            emit = debounce(task => runTask(task), this._debounceMs, scheduleEmit);
        }
        else {
            let initAdd = debounce(task => runTask(task), 0, scheduleEmit);
            emit = () => {
                // This is for the case when cursor.observe
                // is called multiple times in a row
                // when the initial docs are being added.
                if (!init) {
                    initAdd();
                    return;
                }
                runTask(scheduleEmit());
            };
        }
        return gZone.run(() => cursor.observe({
            addedAt: (doc, index) => {
                let change = this._addAt(doc, index);
                changes.push(change);
                emit();
            },
            changedAt: (nDoc, oDoc, index) => {
                let change = this._updateAt(nDoc, index);
                changes.push(change);
                emit();
            },
            movedTo: (doc, fromIndex, toIndex) => {
                let change = this._moveTo(doc, fromIndex, toIndex);
                changes.push(change);
                emit();
            },
            removedAt: (doc, atIndex) => {
                let change = this._removeAt(atIndex);
                changes.push(change);
                emit();
            }
        }));
    }
    _updateAt(doc, index) {
        return new UpdateChange(index, doc);
    }
    _addAt(doc, index) {
        let change = new AddChange(index, doc);
        return change;
    }
    _moveTo(doc, fromIndex, toIndex) {
        return new MoveChange(fromIndex, toIndex);
    }
    _removeAt(index) {
        return new RemoveChange(index);
    }
}