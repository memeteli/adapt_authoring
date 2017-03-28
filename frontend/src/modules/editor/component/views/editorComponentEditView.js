// LICENCE https://github.com/adaptlearning/adapt_authoring/blob/master/LICENSE
define(function(require) {
  var Backbone = require('backbone');
  var Origin = require('core/app/origin');
  var EditorOriginView = require('../../global/views/editorOriginView');

  var EditorComponentEditView = EditorOriginView.extend({
    className: "component-edit",
    tagName: "div",

    preRender: function() {
      this.listenTo(Origin, 'editorComponentEditSidebar:views:save', this.save);
      this.model.set('ancestors', this.model.getPossibleAncestors().toJSON());
    },

    cancel: function (event) {
      event && event.preventDefault();
      Origin.trigger('editorSidebarView:removeEditView', this.model);
    }
  }, {
    template: 'editorComponentEdit'
  });

  return EditorComponentEditView;
});